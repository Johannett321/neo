import { app, safeStorage } from 'electron'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one thing Neo keeps on this machine: who is signed in.
 *
 * Everything else — every workspace, note, meeting and recording — lives in Neo Cloud,
 * and this file is only what it takes to ask for it: the device token the server
 * issued when this machine signed in, and the username to show while it does.
 *
 * Sealed with `safeStorage`, so it is behind the login keychain rather than readable
 * by anything that can read the user's files. A desktop with no keychain at all (a
 * bare Linux session) gets the token in a file only its owner can read, which is what
 * every command-line tool that signs in does too.
 */

export interface Session {
  token: string
  username: string
  accountId: string
  deviceId: string
}

const file = (): string => join(app.getPath('userData'), 'neo-cloud-session')

let cached: Session | null | undefined

export function loadSession(): Session | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    if (!existsSync(file())) return null
    const raw = readFileSync(file())
    const text = raw.subarray(0, 5).toString() === 'plain'
      ? raw.subarray(5).toString('utf8')
      : safeStorage.decryptString(raw)
    const parsed = JSON.parse(text) as Session
    if (parsed?.token && parsed.accountId) cached = parsed
  } catch {
    // Unreadable is signed out: the keychain was reset, or the file came from another machine.
    cached = null
  }
  return cached
}

export function saveSession(session: Session): void {
  const text = JSON.stringify(session)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(file(), safeStorage.encryptString(text))
  } else {
    writeFileSync(file(), Buffer.concat([Buffer.from('plain'), Buffer.from(text, 'utf8')]))
  }
  try {
    chmodSync(file(), 0o600)
  } catch {
    // Windows has no such thing; the profile folder is already the user's own.
  }
  cached = session
}

export function clearSession(): void {
  rmSync(file(), { force: true })
  cached = null
}
