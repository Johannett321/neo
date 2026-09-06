import { BrowserWindow, Notification } from 'electron'
import type { OpenTarget } from '@shared/types'
import { q, q1, today } from '../db/client'
import { invokeChannel, noteWrite, remove } from '../ipc/util'
import { deliveryDue } from './notify'

/**
 * Putting the day's deadlines on the desktop, once.
 *
 * A runner over rows, exactly like the recording pipeline and for the same reason:
 * **nothing important is ever only in memory**. There is no timer holding "we already
 * told them" and no in-process schedule to lose — the fact that a thing was said is a
 * row, so a machine that is restarted four times before lunch, or that slept through
 * nine o'clock and woke at eleven, interrupts you exactly once either way.
 *
 * The tick is deliberately dumb. Every minute it asks whether the morning has
 * arrived, and if it has, asks each workspace what it would say and tries to claim
 * today for each answer. The claim is an insert against a unique index, so the
 * database decides whether this is the first time — not a variable, and not a
 * comparison of timestamps that a clock change could get wrong.
 */

/** Cheap: on a quiet day it is one settings read and nothing else. */
const TICK_MS = 60_000

/** A record of what was said is worth a month and no more. */
const KEEP_DAYS = 30

let timer: ReturnType<typeof setInterval> | null = null
/** How a window is got hold of when one is wanted. Set by main; see startNotifications. */
let ensureWindow: (() => BrowserWindow | null) | null = null

/**
 * Show one, and hand back whether the desktop actually took it.
 *
 * `show()` is asynchronous and does not throw: a notification macOS refuses resolves
 * a moment later on a `failed` event, so the only way to report the truth is to wait
 * for one of the two events. An earlier version of this returned as soon as `show()`
 * had been called and cheerfully said "Sent" while nothing appeared.
 *
 * Never throws. A desktop that will not take notifications — an operating system
 * that has them switched off for this app, a Linux session with no daemon — is
 * something the app is expected to survive, exactly as it survives not being able to
 * hear the other half of a call: the deadline is still on Today, which is where it
 * really lives.
 */
export async function showNotification(input: {
  title: string
  body: string
  target: OpenTarget | null
}): Promise<{ shown: boolean; reason: string }> {
  try {
    if (!Notification.isSupported()) {
      return { shown: false, reason: 'This desktop does not show notifications at all.' }
    }
    const notification = new Notification({ title: input.title, body: input.body })
    if (input.target) {
      const target = input.target
      notification.on('click', () => open(target))
    }

    const outcome = new Promise<{ shown: boolean; reason: string }>((resolve) => {
      notification.on('show', () => resolve({ shown: true, reason: '' }))
      notification.on('failed', (_event, error) =>
        resolve({ shown: false, reason: String(error || 'The desktop refused it.') })
      )
      /*
       * A desktop that answers neither way is still an answer, and one the caller
       * must not hang on. It is generous on purpose: the delivery loop awaits this,
       * and half a second of a background tick costs nothing.
       */
      setTimeout(() => resolve({ shown: true, reason: '' }), 1500).unref?.()
    })

    notification.show()
    return await outcome
  } catch (error) {
    return { shown: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Bring the app forward and put the right thing on screen.
 *
 * The workspace travels with the path and is applied first, because a notification is
 * the one thing in the app that can arrive from a working life you are not currently
 * looking at — following it into the wrong workspace would show an empty project.
 */
function open(target: OpenTarget): void {
  const window = ensureWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.send('open', target)
}

/**
 * One pass. Returns how many notifications were actually put on the desktop, which
 * is what makes the whole thing assertable in a test with no display.
 *
 * `now` is a parameter rather than read inside for the same reason: the interesting
 * behaviour is "what happens at ten past nine on a Tuesday", and a test that has to
 * wait until then is not a test.
 */
export async function deliverNotifications(now: Date = new Date()): Promise<number> {
  const settings = await invokeChannel('settings:get')
  // Nothing at all until the app has been introduced. A first run is a screen you are
  // filling in, and the sample data it can load has deadlines of its own.
  if (!settings.notifications || !settings.onboardedAt) return 0
  if (!deliveryDue(now, settings.notifyAt, settings.notifyWeekends)) return 0

  /*
   * Read straight rather than through `workspace:list`, and this is the one place in
   * main that does. That channel reads every workspace's icon off the disk to build a
   * data URL for a renderer that is not asking — and this runs every minute, all day.
   * The workspace fence is not weakened by it: what comes back is a list of ids, and
   * every question about what is *in* a workspace still goes through the scoped
   * channel below, one workspace at a time.
   */
  const workspaces = await q<{ id: string }>(
    'SELECT id FROM workspace WHERE archived_at IS NULL AND notify ORDER BY sort_order, name'
  )

  const on = today(now)
  let shown = 0

  for (const workspace of workspaces) {
    const pending = await invokeChannel('notification:pending', { workspaceId: workspace.id })
    for (const item of pending) {
      /*
       * Claim the day before saying anything. The unique index is the whole guard:
       * a second pass gets no row back and stays quiet.
       *
       * Written first and shown second on purpose. Crashing between the two costs a
       * nudge that Today would have given you anyway; doing it the other way round
       * would cost a duplicate every time the app was restarted, which is the failure
       * that teaches people to turn notifications off.
       */
      const claimed = await q1<{ id: string }>(
        `INSERT INTO notification (workspace_id, kind, on_date, title, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, kind, on_date) DO NOTHING
         RETURNING id`,
        [workspace.id, item.kind, on, item.title, item.body]
      )
      if (!claimed) continue
      // The claim above has to be one statement; the op is taken from the row it wrote.
      await noteWrite('notification', claimed.id)

      const result = await showNotification({
        title: item.title,
        body: item.body,
        target: { workspaceId: item.workspaceId, path: item.path }
      })
      if (result.shown) shown++
    }
  }

  return shown
}

/** Old records of what was said. Kept a month, so "did it tell me?" stays answerable. */
async function sweep(now: Date): Promise<void> {
  const cutoff = today(new Date(now.getTime() - KEEP_DAYS * 86_400_000))
  /*
   * Through `remove()` so each row leaves a tombstone, and one row at a time because
   * of it. A bare DELETE here was fine while this table was only ever local; with a
   * log behind it, a row deleted without a trace comes back on the next replay — and
   * then collides with a later claim for the same workspace, kind and day, because
   * that pair is exactly what the unique index forbids.
   */
  const stale = await q<{ id: string }>('SELECT id FROM notification WHERE on_date < $1', [cutoff])
  for (const row of stale) await remove('notification', row.id)
}

/** A pass, with anything that goes wrong logged rather than thrown at the app. */
export function kickNotifications(): void {
  void deliverNotifications()
    .then(() => sweep(new Date()))
    .catch((error: unknown) => console.error('Could not deliver notifications:', error))
}

/**
 * Start ticking. `window` is how a clicked notification finds something to show —
 * main owns window creation, so it hands the way in rather than this module
 * reaching for one that may not exist on macOS with every window closed.
 */
export function startNotifications(window: () => BrowserWindow | null): void {
  ensureWindow = window
  if (timer) return
  kickNotifications()
  timer = setInterval(kickNotifications, TICK_MS)
  // A pending tick must never be the reason the process stays awake.
  timer.unref?.()
}

export function stopNotifications(): void {
  if (timer) clearInterval(timer)
  timer = null
}
