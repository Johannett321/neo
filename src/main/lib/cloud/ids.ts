import { isTempId, swapIds } from '@shared/sync'

/**
 * Temporary ids that have since been given real ones.
 *
 * The window draws a new task under `tmp-…` the moment it is made, and may well edit
 * it, move it or hang a membership off it before Neo Cloud has answered — or, offline,
 * long before. The outbox writes each pairing down here when a create comes back, and
 * every handler swaps temporary ids for real ones on the way in (`ipc/util.ts`), so a
 * write naming something created a moment ago lands on the right row.
 *
 * Kept for the session and persisted with the outbox, because a screen can hold a
 * temporary id for as long as it stays open.
 */

const known = new Map<string, string>()

export function rememberId(temp: string, real: string): void {
  if (isTempId(temp) && real && !isTempId(real)) known.set(temp, real)
}

export const realId = (temp: string): string | undefined => known.get(temp)

export const knownIds = (): Record<string, string> => Object.fromEntries(known)

export function loadIds(ids: Record<string, string> | undefined): void {
  for (const [temp, real] of Object.entries(ids ?? {})) rememberId(temp, real)
}

export function forgetIds(): void {
  known.clear()
}

/** Swap every temporary id in a value for the real one it was given. */
export const resolveIds = <T>(value: T): { value: T; unresolved: string[] } => swapIds(value, realId)
