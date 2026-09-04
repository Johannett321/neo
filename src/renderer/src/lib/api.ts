import { useCallback } from 'react'
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
 * Every mutation invalidates everything. The whole dataset is a few thousand rows
 * held locally, and almost every write moves a derived number somewhere else —
 * what needs a look, the Today counts, the review lists. Refetching the lot is cheaper
 * to reason about and imperceptible in practice.
 */
export function useApiMutation<C extends Channel>(channel: C) {
  const client = useQueryClient()
  return useMutation<Output<C>, Error, Input<C>>({
    mutationFn: (input: Input<C>) => window.api.invoke(channel, input),
    onSuccess: () => {
      void client.invalidateQueries()
    }
  })
}

/**
 * Warm a screen's data before it is asked for. Every query here costs a couple of
 * milliseconds against an in-process database, but those milliseconds land *after*
 * the click, which is exactly where they are felt. Fetching on hover moves them
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
