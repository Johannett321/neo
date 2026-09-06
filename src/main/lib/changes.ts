import { BrowserWindow } from 'electron'

/**
 * "Something was written that the window did not write itself."
 *
 * A mutation made by a click invalidates the renderer's cache on the way back —
 * `useApiMutation` does it, and there is nothing to tell anyone about. A write made
 * by the assistant or by Claude Desktop through the bridge goes down exactly the same
 * channels, but from inside the main process, so no mutation ever resolves in the
 * renderer and the screen has no idea anything moved. Until now that meant a task the
 * assistant had just created only appeared once you navigated away and came back.
 *
 * The message carries nothing. What changed is not worth describing when the whole
 * dataset is a few thousand local rows and a write moves derived numbers all over the
 * app — the screen refetches the lot, for the same reason a mutation does.
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
 * call schedules the announcement and the rest ride along on it, so a tool that saves
 * a project, moves a card and logs activity produces one refetch rather than three.
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
