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
 * health, the Today counts, the review lists. Refetching the lot is both cheaper
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

export const openExternal = (url: string): void => {
  void call('shell:openExternal', { url })
}
