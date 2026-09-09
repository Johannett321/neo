import { shell } from 'electron'
import { handle } from './util'
import type { SyncStatus } from '@shared/sync'
import { NUDGE_AFTER_DAYS, NUDGE_AFTER_PROJECTS } from '@shared/sync'
import { exec, q1 } from '../db/client'
import * as engine from '../lib/sync/engine'
import { signInWithPasskey } from '../lib/sync/signin'
import { Relay } from '../lib/sync/relay'

/**
 * Syncing, as the screen sees it. A status line, a sign-in, and two links to Stripe.
 */
export function registerSyncHandlers(): void {
  handle('sync:status', async (): Promise<SyncStatus> => engine.status())

  /**
   * Sign in, and that is the whole of it.
   *
   * There used to be a second step: a passphrase, which never left this process and
   * was the only thing that could open anything on the server. There is nothing to
   * open now, so a passkey and the token it comes back with are all a device needs —
   * and the first pass afterwards hands over everything already on this machine.
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
    void engine.start()
    return { connected: true, handle: account.handle }
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

  /**
   * Money, and the only two channels here that reach a payment provider at all.
   *
   * The app never sees a card. It asks the sync server for a link and opens it in the
   * real browser — not a window Neo owns, because a payment page whose address bar
   * nobody can see is the one thing everybody is told to check before typing a card
   * into it.
   */
  handle('sync:prices', async () => engine.prices())

  handle('sync:pay', async ({ kind }) => {
    const url = await engine.payLink(kind)
    if (!/^https:\/\//.test(url)) throw new Error('That is not a link worth opening.')
    await shell.openExternal(url)
    return { opened: true }
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
