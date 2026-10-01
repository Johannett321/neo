import { app, safeStorage } from 'electron'
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A file in the user-data folder that only this account on this machine can read.
 *
 * Sealed with `safeStorage`, so it is behind the login keychain rather than readable by
 * anything that can read the user's files. A desktop with no keychain at all (a bare
 * Linux session) gets a file only its owner can read, marked `plain` so it is never
 * mistaken for ciphertext — which is what every command-line tool that signs in does.
 *
 * Three things are kept this way: the session (`session.ts`), the last-known copy of
 * the window's data (`cache.ts`) and the writes waiting for Neo Cloud (`outbox.ts`).
 */

export const sealedPath = (name: string): string => join(app.getPath('userData'), name)

export function readSealed<T>(name: string): T | null {
  try {
    const file = sealedPath(name)
    if (!existsSync(file)) return null
    const raw = readFileSync(file)
    const text = raw.subarray(0, 5).toString() === 'plain'
      ? raw.subarray(5).toString('utf8')
      : safeStorage.decryptString(raw)
    return JSON.parse(text) as T
  } catch {
    // Unreadable is absent: the keychain was reset, or the file came from another machine.
    return null
  }
}

export function writeSealed(name: string, value: unknown): void {
  const file = sealedPath(name)
  const text = JSON.stringify(value)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(file, safeStorage.encryptString(text))
  } else {
    writeFileSync(file, Buffer.concat([Buffer.from('plain'), Buffer.from(text, 'utf8')]))
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no such thing; the profile folder is already the user's own.
  }
}

export function removeSealed(name: string): void {
  rmSync(sealedPath(name), { force: true })
}

/** Every sealed file whose name starts with this, for clearing one kind at once. */
export function listSealed(prefix: string): string[] {
  try {
    return readdirSync(app.getPath('userData')).filter((name) => name.startsWith(prefix))
  } catch {
    return []
  }
}
