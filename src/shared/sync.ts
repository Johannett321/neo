/**
 * What the renderer is allowed to know about syncing.
 *
 * Deliberately small, and deliberately without a single key in it. The passphrase
 * goes one way — into main, once — and nothing that could open anything ever comes
 * back out.
 */

export type SyncTier = 'local' | 'neo' | 'self'

export interface SyncConfig {
  /** Empty means Local: no account, no network, exactly the app as it was. */
  serverUrl: string
  accountHandle: string
  /** Which of the three this machine is running as. Derived, never chosen twice. */
  tier: SyncTier
}

export type SyncPhase =
  /** No server configured. The whole of Local. */
  | 'off'
  /** Configured, but the passphrase has not been given since this app started. */
  | 'locked'
  | 'connecting'
  | 'idle'
  | 'syncing'
  | 'error'

/**
 * What the app is told about money, and all of it comes from the sync server's own
 * columns rather than from Stripe — so a status line never waits on a third party.
 *
 * `billed: false` is a server that does not take payments: anybody's own copy. Then
 * there is no plan, no trial and nothing to buy, and the pane says none of it.
 */
export interface SyncBilling {
  billed: boolean
  /** trial | active | past_due | canceled, or 'self' on a server that never charges. */
  plan: string
  /** Reading is never refused. This is whether new work can be *sent*. */
  mayWrite: boolean
  trialEndsAt: string
  renewsAt: string
  /** Subscribed, but stopping at the end of the period rather than renewing. */
  endingAt: boolean
  /** Whether Stripe already knows this account, which is what decides the button. */
  hasCustomer: boolean
  monthly: string
  yearly: string
}

export const NO_BILLING: SyncBilling = {
  billed: false, plan: 'self', mayWrite: true, trialEndsAt: '', renewsAt: '',
  endingAt: false, hasCustomer: false, monthly: '', yearly: ''
}

export interface SyncStatus {
  phase: SyncPhase
  serverUrl: string
  accountHandle: string
  deviceName: string
  /** The last thing that went wrong, in words, or empty. */
  error: string
  /** ISO timestamp of the last completed pass, or empty for never. */
  lastSyncedAt: string
  /** Batches this device has written and not yet handed over. */
  pending: number
  /** Whether the live stream is attached, rather than only polling. */
  live: boolean
  /** Files another device has not handed over yet. Ordinary, not a fault. */
  filesWaiting: number
  /** Files this device could not send because the account is out of space. */
  filesOverQuota: number
  /** File storage, in bytes. Zero quota means the server has not said yet. */
  usedBytes: number
  quotaBytes: number
  /**
   * Whether this machine is the one setting the passphrase rather than typing an
   * existing one. Answered by asking the server whether the account has any wrapped
   * key material — the only honest way to know, and not the same question as "does
   * this Mac have workspaces on it", which is what it used to guess from.
   */
  firstDevice: boolean
  billing: SyncBilling
  workspaces: { workspaceId: string; name: string; remoteSeq: number }[]
}

/** What a sign-in needs. The passphrase is used and dropped; it is never stored. */
export interface SyncConnect {
  serverUrl: string
  passphrase: string
  /** Blank on the machine that already has the work; typed on the second one. */
  deviceName: string
}

export const DEFAULT_SYNC_SERVER = 'https://neo-sync-production.up.railway.app'

/**
 * When Neo mentions syncing to somebody who has never been offered it.
 *
 * Not in onboarding: asking somebody to value syncing before they have made a
 * workspace is asking them to price something they have not used. And a real signal
 * rather than a timer — a fortnight of use *and* enough work to be worth losing —
 * because "you have had this a while" is not a reason to want a second copy of it.
 */
export const NUDGE_AFTER_DAYS = 14
export const NUDGE_AFTER_PROJECTS = 3

/** Long enough that a flaky network is not a spinner, short enough to feel live. */
export const POLL_INTERVAL_MS = 60_000
