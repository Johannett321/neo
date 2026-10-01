import { loadSession } from './session'
import { listSealed, readSealed, removeSealed, writeSealed } from './sealed'

/**
 * The last-known copy of what the window has drawn, so it can draw it again while Neo
 * Cloud cannot be reached.
 *
 * It is the renderer's own query cache, dehydrated — the same answers the channels
 * gave, nothing derived and nothing more — sealed with `safeStorage` like the session
 * and named for the account it belongs to. Neo Cloud stays the source of truth: the
 * copy is replaced whole every time the window's data changes, is never sent anywhere,
 * and is thrown away on signing out, on being signed out from elsewhere, and when a
 * different account signs in.
 */

const PREFIX = 'neo-cache-'

interface Stored {
  accountId: string
  savedAt: string
  state: unknown
}

const fileFor = (accountId: string): string => `${PREFIX}${accountId}`

export function saveCache(state: unknown): void {
  // Signed out, there is nobody for it to belong to — and a window that has just been
  // emptied by signing out must not write its empty cache under the next account.
  const session = loadSession()
  if (!session) return
  const stored: Stored = { accountId: session.accountId, savedAt: new Date().toISOString(), state }
  writeSealed(fileFor(session.accountId), stored)
}

export function loadCache(): { savedAt: string; state: unknown } | null {
  const session = loadSession()
  if (!session) return null
  const stored = readSealed<Stored>(fileFor(session.accountId))
  if (!stored || stored.accountId !== session.accountId) return null
  return { savedAt: stored.savedAt, state: stored.state }
}

/** Every account's copy, or every one but the account named. */
export function forgetCaches(except?: string): void {
  for (const name of listSealed(PREFIX)) {
    if (except && name === fileFor(except)) continue
    removeSealed(name)
  }
}
