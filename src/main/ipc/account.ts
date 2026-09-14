import { app } from 'electron'
import type { AccountDevice, AccountStatus } from '@shared/account'
import { SIGNED_OUT } from '@shared/account'
import { api, CloudError, cloudUrl, must } from '../lib/cloud/client'
import { startEvents, stopEvents } from '../lib/cloud/events'
import { signInWithPasskey } from '../lib/cloud/passkey'
import { clearSession, loadSession, saveSession, type Session } from '../lib/cloud/session'
import { forgetMedia } from '../lib/recording/media'
import { handle } from './util'

/**
 * Signing in to Neo Cloud, and knowing whether this machine is.
 *
 * There is no Neo without an account: everything lives on the server, so the window
 * opens on the sign-in screen until this says otherwise. A username and password are
 * typed in Neo's own window; a passkey is used in the person's own browser (see
 * `lib/cloud/passkey.ts`). Either way what is kept here is the device token and nothing
 * else.
 */

const deviceName = (): string =>
  `Neo on ${process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'}`

export async function accountStatus(): Promise<AccountStatus> {
  const session = loadSession()
  if (!session) return { ...SIGNED_OUT, serverUrl: cloudUrl() }
  try {
    const account = await must(api.GET('/v1/account'))
    return {
      signedIn: true,
      username: account.username,
      hasPassword: account.hasPassword,
      plan: account.plan,
      features: account.features,
      storage: account.storage,
      offline: false,
      serverUrl: cloudUrl()
    }
  } catch (error) {
    // A 401 has already signed this machine out; anything else is the network.
    if (!loadSession()) return { ...SIGNED_OUT, serverUrl: cloudUrl() }
    if (error instanceof CloudError && error.status !== 0 && error.status < 500) throw error
    return { ...SIGNED_OUT, signedIn: true, username: session.username, offline: true, serverUrl: cloudUrl() }
  }
}

async function begin(session: Session): Promise<AccountStatus> {
  saveSession(session)
  startEvents()
  return accountStatus()
}

export function registerAccountHandlers(): void {
  handle('account:status', accountStatus)

  handle('account:register', async ({ username, password }) => {
    const session = await must(api.POST('/v1/auth/password/register', {
      body: { username, password, deviceName: deviceName(), platform: process.platform }
    }))
    return begin(session)
  })

  handle('account:signIn', async ({ username, password }) => {
    const session = await must(api.POST('/v1/auth/password/login', {
      body: { username, password, deviceName: deviceName(), platform: process.platform }
    }))
    return begin(session)
  })

  handle('account:passkey', async () => {
    const signedIn = await signInWithPasskey(cloudUrl())
    if (!signedIn) return accountStatus()
    return begin({
      token: signedIn.token,
      accountId: signedIn.accountId,
      deviceId: signedIn.deviceId,
      username: signedIn.username
    })
  })

  handle('account:signOut', async () => {
    try {
      if (loadSession()) await must(api.POST('/v1/auth/logout'))
    } catch {
      // Signed out here whatever the server says: the button means "not from this machine".
    }
    stopEvents()
    clearSession()
    forgetMedia()
    return { ...SIGNED_OUT, serverUrl: cloudUrl() }
  })

  handle('account:changePassword', async ({ currentPassword, newPassword }) => {
    await must(api.PUT('/v1/account/password', { body: { currentPassword, newPassword } }))
    return accountStatus()
  })

  handle('account:devices', async (): Promise<AccountDevice[]> => must(api.GET('/v1/devices')))

  handle('account:revokeDevice', async ({ deviceId }) => {
    await must(api.DELETE('/v1/devices/{deviceId}', { params: { path: { deviceId } } }))
    return must(api.GET('/v1/devices'))
  })
}

/** The version is the one thing the account pane shows that is not the server's. */
export const appVersion = (): string => app.getVersion()
