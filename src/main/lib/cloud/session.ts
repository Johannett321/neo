import { readSealed, removeSealed, writeSealed } from './sealed'

/**
 * Who is signed in.
 *
 * Every workspace, note, meeting and recording lives in Neo Cloud, and this file is
 * what it takes to ask for them: the device token the server issued when this machine
 * signed in, and the username to show while it does. Sealed with `safeStorage` (see
 * `sealed.ts`). The last-known copy of the work and the writes waiting to be sent are
 * kept beside it, per account, and go when it goes — see `cache.ts` and `outbox.ts`.
 */

export interface Session {
  token: string
  username: string
  accountId: string
  deviceId: string
}

const FILE = 'neo-cloud-session'

let cached: Session | null | undefined

export function loadSession(): Session | null {
  if (cached !== undefined) return cached
  const parsed = readSealed<Session>(FILE)
  cached = parsed?.token && parsed.accountId ? parsed : null
  return cached
}

export function saveSession(session: Session): void {
  writeSealed(FILE, session)
  cached = session
}

export function clearSession(): void {
  removeSealed(FILE)
  cached = null
}
