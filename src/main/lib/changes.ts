import { BrowserWindow } from 'electron'

/**
 * "Something was written that the window did not write itself."
 *
 * A mutation made by a click invalidates the renderer's cache on the way back —
 * `useApiMutation` does it, and there is nothing to tell anyone about. A write made
 * anywhere else — another device, the assistant's tools running in Neo Cloud, Claude
 * through the remote connector — reaches this machine as `changed` on the event stream
 * (`cloud/events.ts`), and no mutation ever resolves in the renderer for it.
 *
 * The message carries nothing. What changed is not worth describing when a write moves
 * derived numbers all over the app — the screen refetches the lot, for the same reason
 * a mutation does.
 */

/** Long enough to fold a tool's several writes into one refetch, short enough to be unseen. */
const COALESCE_MS = 80

type Listener = () => void
const listeners = new Set<Listener>()
let pending: ReturnType<typeof setTimeout> | null = null

/** Watch from inside main. Returns an unsubscribe function. */
export function onChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Say that a write landed. Calling it repeatedly inside one burst is free: the first
 * call schedules the announcement and the rest ride along on it, so a burst of
 * writes from one tool call produces one refetch rather than three.
 */
export function announceChange(): void {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('data')
    }
    for (const listener of [...listeners]) listener()
  }, COALESCE_MS)
  // A pending announcement must never be the reason the process stays awake.
  pending.unref?.()
}
