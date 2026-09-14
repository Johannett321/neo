/**
 * Who is signed in, as the window is allowed to know it.
 *
 * Neo keeps everything in Neo Cloud and nothing on the device, so an account is not
 * optional: the app opens on the sign-in screen until there is one. The token never
 * reaches the renderer — this is a status line and nothing that could be used to act
 * as the account.
 */

export interface AccountStatus {
  signedIn: boolean
  /** Empty when signed out. */
  username: string
  /** Whether this account can sign in with a password as well as a passkey. */
  hasPassword: boolean
  /** The plan, in words. Everybody is on Free, and Free includes everything, for now. */
  plan: { id: string; name: string }
  /**
   * What the plan includes. All true today; asked anyway, so a feature can later be
   * kept for a paid plan without the app having to learn a new question.
   */
  features: { recording: boolean; transcription: boolean; assistant: boolean; fileStorage: boolean }
  storage: { usedBytes: number; quotaBytes: number }
  /**
   * Signed in, but Neo Cloud could not be reached just now. The window shows that
   * rather than the sign-in screen: the account is fine, the network is not.
   */
  offline: boolean
  /** The server this app talks to, for the account pane. */
  serverUrl: string
}

export const SIGNED_OUT: AccountStatus = {
  signedIn: false,
  username: '',
  hasPassword: false,
  plan: { id: 'free', name: 'Free' },
  features: { recording: true, transcription: true, assistant: true, fileStorage: true },
  storage: { usedBytes: 0, quotaBytes: 0 },
  offline: false,
  serverUrl: ''
}

export interface AccountDevice {
  deviceId: string
  name: string
  platform: string
  lastSeenAt: string
  revoked: boolean
  thisOne: boolean
}
