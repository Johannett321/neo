import { ipcMain } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import { writeCount } from '../lib/cloud/client'
import { announceChange } from '../lib/changes'

/**
 * Every registered handler, kept so the process can call its own channels.
 *
 * The assistant's tools and Claude Desktop's connector are the same channels the
 * renderer uses rather than a second set of requests beside them, which is what makes
 * an assistant-made task identical to a hand-made one: it goes to Neo Cloud the same
 * way, and the server logs it the same way, because it *is* that code path.
 */
const registry = new Map<string, (input: unknown) => Promise<unknown>>()

export function handle<C extends Channel>(
  channel: C,
  fn: (input: Input<C>) => Promise<Output<C>> | Output<C>
): void {
  const run = async (input: unknown): Promise<Output<C>> => fn(input as Input<C>)
  registry.set(channel, run as (input: unknown) => Promise<unknown>)
  ipcMain.handle(channel, async (_event, input) => run(input))
}

/**
 * Call a channel from inside the main process. Channels that take an input require
 * one, exactly as they do from the renderer — a workspace-scoped channel called with
 * nothing would otherwise ask for everything.
 *
 * This is also the one place that knows a write happened with nobody in the renderer
 * waiting on it. A click resolves a mutation and the mutation invalidates the cache; a
 * tool call does not, so the window is told here instead. Whether anything was written
 * is read off the client — a request that changes something and succeeded — rather
 * than a list of "the channels that write", which would drift.
 */
export async function invokeChannel<C extends Channel>(
  channel: C,
  ...args: Input<C> extends void ? [input?: undefined] : [input: Input<C>]
): Promise<Output<C>> {
  const fn = registry.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  const before = writeCount()
  try {
    return (await fn(args[0])) as Output<C>
  } finally {
    if (writeCount() !== before) announceChange()
  }
}

/** Only the fields a draft actually carries, with the id taken off. */
export function withoutId<T extends { id?: string }>(draft: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = draft
  return rest
}
