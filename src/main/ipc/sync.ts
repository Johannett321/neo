import { handle } from './util'
import type { SyncStatus } from '@shared/sync'
import { NUDGE_AFTER_DAYS, NUDGE_AFTER_PROJECTS } from '@shared/sync'
import { exec, q1 } from '../db/client'
import * as engine from '../lib/sync/engine'
import { passphraseComplaint } from '../lib/sync/crypto'
import { signInWithPasskey } from '../lib/sync/signin'
import { Relay } from '../lib/sync/relay'

/**
 * Syncing, as the screen sees it.
 *
 * The passphrase goes one way through here and is never returned, logged or stored.
 * Everything else is a status line.
 */
export function registerSyncHandlers(): void {
  handle('sync:status', async (): Promise<SyncStatus> => engine.status())

  /**
   * Sign in, then ask for the passphrase. Two steps because they are two different
   * questions — who this account belongs to, which the server answers, and what
   * opens it, which only this machine ever knows.
   */
  handle('sync:signIn', async ({ serverUrl }) => {
    const url = serverUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(url)) {
      throw new Error('A sync server address starts with https://')
    }
    // http is allowed only for a server on this machine, which is how the thing is
    // developed. Anywhere else it would put the device token on the wire in clear.
    if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url)) {
      throw new Error('A sync server has to be https, unless it is on this machine.')
    }

    const signedIn = await signInWithPasskey(url)
    if (!signedIn) return { connected: false, handle: '' }

    // Proves the token before anything is written down, so a half-configured
    // machine is not a state anybody has to get out of by hand.
    const account = await new Relay(url, signedIn.token).account()
    await engine.saveConnection(url, signedIn.token, account.accountId, account.handle,
      `Neo on ${process.platform === 'darwin' ? 'this Mac' : process.platform}`)
    return { connected: true, handle: account.handle }
  })

  handle('sync:unlock', async ({ passphrase }) => {
    const complaint = passphraseComplaint(passphrase)
    if (complaint) return { ok: false, reason: complaint }

    const result = await engine.unlock(passphrase)
    if (result.ok) void engine.start()
    return { ok: result.ok, reason: result.reason ?? '' }
  })

  /**
   * Whether to mention syncing to somebody who has never been offered it.
   *
   * Two conditions, and both are about the work rather than the calendar: Neo has
   * been in use for a fortnight *and* holds enough that losing it would matter. The
   * age is taken from the oldest workspace rather than from an install marker,
   * because an install that predates all of this has no marker and is exactly the
   * case worth reaching.
   */
  handle('sync:nudge', async () => {
    const shown = await q1<{ value: string }>(
      `SELECT value FROM setting WHERE key = 'syncNudgeShownAt'`
    )
    if (shown) return { show: false }
    if ((await engine.status()).phase !== 'off') return { show: false }

    const enough = await q1<{ projects: number; days: number }>(
      `SELECT (SELECT count(*)::int FROM project WHERE archived_at IS NULL) AS projects,
              COALESCE(EXTRACT(DAY FROM now() - min(created_at))::int, 0) AS days
         FROM workspace`
    )
    return {
      show: (enough?.projects ?? 0) >= NUDGE_AFTER_PROJECTS &&
            (enough?.days ?? 0) >= NUDGE_AFTER_DAYS
    }
  })

  /** Said once, and then never again, whichever button was pressed. */
  handle('sync:dismissNudge', async () => {
    await exec(
      `INSERT INTO setting (key, value) VALUES ('syncNudgeShownAt', $1)
       ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()]
    )
    return { show: false }
  })

  handle('sync:now', async () => {
    await engine.syncNow()
    return engine.status()
  })

  /**
   * Stops syncing on this machine and forgets the account. Nothing on the server is
   * touched: the point of the button is "not from here", not "destroy my backup".
   */
  handle('sync:disconnect', async () => {
    await engine.disconnect()
    return engine.status()
  })
}
