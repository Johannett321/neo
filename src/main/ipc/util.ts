import { ipcMain } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import { resolveIds } from '../lib/cloud/ids'

/**
 * Every registered handler, kept so the process can call its own channels.
 *
 * The notification runner and start-up read settings and workspaces through the same
 * channels the renderer uses rather than a second set of requests beside them, so there
 * is one way to ask Neo Cloud each question.
 */
const registry = new Map<string, (input: unknown) => Promise<unknown>>()

export function handle<C extends Channel>(
  channel: C,
  fn: (input: Input<C>) => Promise<Output<C>> | Output<C>
): void {
  /*
   * A temporary id (`shared/sync.ts`) is the window's name for something it has drawn
   * before Neo Cloud gave it a real one. Swapped here, on the way into every handler,
   * so a write that names it lands on the right row — and refused here if it still has
   * no real id, because a temporary one must never reach the server. The outbox and
   * the cache carry them on purpose and are left alone: they are what does the swapping.
   */
  const carriesTemp = channel.startsWith('sync:') || channel.startsWith('cache:')
  const run = async (input: unknown): Promise<Output<C>> => {
    if (carriesTemp) return fn(input as Input<C>)
    const { value, unresolved } = resolveIds(input)
    if (unresolved.length > 0) throw new Error('That is still being saved. Try again in a moment.')
    return fn(value as Input<C>)
  }
  registry.set(channel, run as (input: unknown) => Promise<unknown>)
  ipcMain.handle(channel, async (_event, input) => run(input))
}

/**
 * Call a channel from inside the main process. Channels that take an input require
 * one, exactly as they do from the renderer — a workspace-scoped channel called with
 * nothing would otherwise ask for everything.
 */
export async function invokeChannel<C extends Channel>(
  channel: C,
  ...args: Input<C> extends void ? [input?: undefined] : [input: Input<C>]
): Promise<Output<C>> {
  const fn = registry.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return (await fn(args[0])) as Output<C>
}

/** Only the fields a draft actually carries, with the id taken off. */
export function withoutId<T extends { id?: string }>(draft: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = draft
  return rest
}
