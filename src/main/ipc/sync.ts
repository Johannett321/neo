import { loadCache, saveCache } from '../lib/cloud/cache'
import { discard, retry, submit, syncState } from '../lib/cloud/outbox'
import { handle } from './util'

/**
 * Working on while Neo Cloud cannot be reached: the writes kept until it can be
 * (`lib/cloud/outbox.ts`), and the last-known copy of the window's data that lets it
 * draw something in the meantime (`lib/cloud/cache.ts`). Both are sealed on disk, per
 * account, and both go when the account signs out.
 */
export function registerSyncHandlers(): void {
  handle('sync:submit', ({ id, channel, input, tempId, label }) => submit({ id, channel, input, tempId, label }))
  handle('sync:state', () => syncState())
  handle('sync:retry', ({ id }) => retry(id))
  handle('sync:discard', ({ id }) => discard(id))

  handle('cache:load', () => loadCache())
  handle('cache:save', ({ state }) => saveCache(state))
}
