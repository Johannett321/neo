import { handle } from './util'
import type { SyncStatus } from '@shared/sync'
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
