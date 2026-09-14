import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { Channel, Input, Output } from '@shared/api'

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

/**
 * Every mutation invalidates everything. The dataset is small, and almost every write
 * moves a derived number somewhere else — what needs a look, the Today counts, the
 * review lists. Refetching the lot is cheaper to reason about than working out which
 * screens a write touched, and the requests are to one server, answered in a moment.
 */
export function useApiMutation<C extends Channel>(channel: C) {
  const client = useQueryClient()
  return useMutation<Output<C>, Error, Input<C>>({
    mutationFn: (input: Input<C>) => window.api.invoke(channel, input),
    onSuccess: () => {
      void client.invalidateQueries(everythingButTheAccount)
    }
  })
}

/**
 * Refetch when something was written that this window did not write.
 *
 * Three ways that happens: another device signed in to the same account (Neo Cloud says
 * so on its event stream), the assistant, or the Claude Desktop connector — the last
 * two call the app's own channels from inside the main process, so no mutation resolves
 * here. Main says a write landed and the cache goes, exactly as `useApiMutation` does
 * it, so the card appears while the assistant is still talking. Mounted once, at the top.
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
