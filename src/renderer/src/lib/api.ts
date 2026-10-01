import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { Channel, Input, Output } from '@shared/api'
import { tempId as newTempId, type SyncableChannel } from '@shared/sync'
import { contextFor, Draft, optimistFor, type Optimist } from './optimistic'
import { finishOp, reconcile, relay, startOp } from './sync'
import { useToastIfAny } from './toast'

/**
 * Channels that take an input require one. Without this, a scoped channel could be
 * called with no workspace and quietly return everything.
 */
type Args<C extends Channel, Rest extends unknown[] = []> = Input<C> extends void
  ? [input?: undefined, ...rest: Rest]
  : [input: Input<C>, ...rest: Rest]

export function call<C extends Channel>(channel: C, ...args: Args<C>): Promise<Output<C>> {
  return window.api.invoke(channel, args[0] as Input<C>)
}

type QueryOpts<C extends Channel> = Omit<
  UseQueryOptions<Output<C>, Error, Output<C>, readonly unknown[]>,
  'queryKey' | 'queryFn'
>

export function useApi<C extends Channel>(channel: C, ...args: Args<C, [options?: QueryOpts<C>]>) {
  const [input, options] = args as [Input<C> | undefined, QueryOpts<C> | undefined]
  return useQuery<Output<C>, Error, Output<C>, readonly unknown[]>({
    queryKey: [channel, input ?? null],
    queryFn: () => window.api.invoke(channel, input as Input<C>),
    ...options
  })
}

/**
 * Everything the work is, which is everything but the account itself. Who is signed in
 * does not change because a task did, and is asked for again only when it could have.
 */
const everythingButTheAccount = { predicate: (query: { queryKey: readonly unknown[] }) =>
  query.queryKey[0] !== 'account:status' }

/** What a mutation hands its own callbacks: the input, and the write it became if it was drawn ahead. */
interface Prepared<C extends Channel> {
  input: Input<C>
  op?: {
    id: string
    tempId?: string
    label: string
    draft: Draft
    placeholder?: Output<C> | void
    /** Neo Cloud could not be reached, so it is waiting in line rather than sent. */
    queued?: boolean
  }
}

interface MutateCallbacks<C extends Channel> {
  onSuccess?: (output: Output<C>) => void
  onError?: (error: Error) => void
  onSettled?: () => void
}

/**
 * A write.
 *
 * **Every mutation invalidates everything** once it lands. The dataset is small, and
 * almost every write moves a derived number somewhere else — what needs a look, the
 * Today counts, the review lists. Refetching the lot is cheaper to reason about than
 * working out which screens a write touched.
 *
 * **The common writes are drawn before Neo Cloud answers.** A channel with an entry in
 * `optimistic.ts` — tasks, people and their roles, decisions, the log, links, notes —
 * changes the screens' cached data the moment it is called, so a dialog can close on
 * Save and the card is already on the board. The write then goes to main's outbox
 * (`sync:submit`), which sends it in order behind anything already waiting. Three ways
 * it can end:
 *
 * - **sent**: a new thing's temporary id is swapped for its real one everywhere it is
 *   cached, then everything is refetched as before, so the guess becomes the truth
 *   without the row ever leaving the screen (`stableKey`).
 * - **queued**: Neo Cloud cannot be reached. The guess stays, the write waits on disk,
 *   and the caller is answered with the guess — a dialog waiting on `mutateAsync` gets
 *   a task with a temporary id, which every later write may name.
 * - **refused**: the guess is taken back out and a toast says what was not saved and
 *   why. Nothing is half-done: the write was never in Neo Cloud.
 *
 * `mutate` returns the guess, synchronously, so a call site can chain writes without
 * waiting — a new person, and then their place on the project, in one click.
 */
export function useApiMutation<C extends Channel>(channel: C) {
  const client = useQueryClient()
  const toast = useToastIfAny()
  const optimist = optimistFor(channel) as Optimist<C> | undefined

  const mutation = useMutation<Output<C>, Error, Prepared<C>>({
    mutationFn: async ({ input, op }) => {
      if (!op) return window.api.invoke(channel, input)
      const result = await window.api.invoke('sync:submit', {
        id: op.id,
        channel: channel as SyncableChannel,
        input,
        tempId: op.tempId,
        label: op.label
      })
      if (result.state === 'sent') return result.output as Output<C>
      op.queued = true
      return (op.placeholder ?? input) as Output<C>
    },
    onSuccess: (output, { op }) => {
      if (op) {
        finishOp(op.id)
        // Still in line: keep drawing the guess. It is refetched once the line is sent.
        if (op.queued) return
        if (op.tempId) reconcile(client, op.tempId, (output as { id?: string } | null)?.id)
      }
      void client.invalidateQueries(everythingButTheAccount)
    },
    onError: (error, { op }) => {
      if (!op) return
      finishOp(op.id)
      op.draft.restore()
      // Putting back what this write replaced may have taken another waiting write's
      // guess with it; lay the ones still waiting over the top again.
      relay(client)
      toast?.({ tone: 'error', title: `Not saved: ${op.label}`, detail: error.message, icon: 'alert' })
      void client.invalidateQueries(everythingButTheAccount)
    }
  })

  const prepare = (input: Input<C>): Prepared<C> => {
    if (!optimist) return { input }
    const tempId = optimist.creates?.(input) ? newTempId() : undefined
    const draft = new Draft(client)
    const label = optimist.label(input, draft)
    let placeholder: Output<C> | void = undefined
    try {
      placeholder = optimist.apply(input, draft, contextFor(tempId))
    } catch {
      // Not being able to draw the guess is no reason not to send the write.
    }
    const op = { id: crypto.randomUUID(), tempId, label, draft, placeholder }
    startOp({ id: op.id, channel, input, tempId })
    return { input, op }
  }

  const callbacks = (given?: MutateCallbacks<C>) =>
    given && {
      onSuccess: (output: Output<C>) => given.onSuccess?.(output),
      onError: (error: Error) => given.onError?.(error),
      onSettled: () => given.onSettled?.()
    }

  return {
    ...mutation,
    /** Fire the write. Returns what was drawn for it, when it was drawn ahead. */
    mutate: (input: Input<C>, given?: MutateCallbacks<C>): Output<C> | void => {
      const prepared = prepare(input)
      mutation.mutate(prepared, callbacks(given))
      return prepared.op?.placeholder
    },
    mutateAsync: (input: Input<C>): Promise<Output<C>> => mutation.mutateAsync(prepare(input))
  }
}

/**
 * What a mutation does on the way back, for a write made with `call()` instead. That is
 * the shape a write takes when it has to outlive the component that made it — a row on
 * Today has gone by the time its *Undo* is pressed, and a hook's mutation belongs to the
 * hook.
 */
export function useRefresh(): () => void {
  const client = useQueryClient()
  return useCallback(() => void client.invalidateQueries(everythingButTheAccount), [client])
}

/**
 * Refetch when something was written that this window did not write.
 *
 * Three ways that happens: another device signed in to the same account, the assistant's
 * tools, or Claude through the remote connector — all three write in Neo Cloud, which
 * says so on its event stream, and no mutation resolves here. Main says a write landed
 * and the cache goes, exactly as `useApiMutation` does it, so the card appears while the
 * assistant is still talking. Mounted once, at the top.
 */
export function useLiveData(): void {
  const client = useQueryClient()
  useEffect(() => window.api.onData(() => void client.invalidateQueries(everythingButTheAccount)), [client])
}

/**
 * Warm a screen's data before it is asked for. Every query here is a round trip to Neo
 * Cloud, and that time lands *after* the click, which is exactly where it is felt. Fetching on hover moves them
 * into the time the pointer is already travelling, so the screen has its content
 * on the first frame it paints instead of arriving empty and filling in.
 */
export function usePrefetch(): <C extends Channel>(channel: C, ...args: Args<C>) => void {
  const client = useQueryClient()
  return useCallback(
    <C extends Channel>(channel: C, ...args: Args<C>) => {
      void client.prefetchQuery({
        queryKey: [channel, args[0] ?? null],
        queryFn: () => window.api.invoke(channel, args[0] as Input<C>),
        // Hovering back and forth across a list must not refire on every pass.
        staleTime: 10_000
      })
    },
    [client]
  )
}

export const openExternal = (url: string): void => {
  void call('shell:openExternal', { url })
}
