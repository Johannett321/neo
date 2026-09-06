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
  workspaces: { workspaceId: string; name: string; remoteSeq: number }[]
}

/** What a sign-in needs. The passphrase is used and dropped; it is never stored. */
export interface SyncConnect {
  serverUrl: string
  passphrase: string
  /** Blank on the machine that already has the work; typed on the second one. */
  deviceName: string
}

export const DEFAULT_SYNC_SERVER = 'https://sync.neo.svartdal.com'

/** Long enough that a flaky network is not a spinner, short enough to feel live. */
export const POLL_INTERVAL_MS = 60_000
