/**
 * Keeping the app up to date, and the one thing that costs.
 *
 * Neo updates itself: it asks GitHub what the latest release is, downloads it,
 * swaps the bundle while nobody is looking and comes back running the new one. No
 * disk image, no dragging, no "a newer version is available" that turns out to mean
 * "go and do it yourself".
 *
 * The price is paid on macOS and it is worth naming here rather than burying it.
 * There is no Developer ID certificate, so every build is ad-hoc signed — and macOS
 * remembers a privacy permission against the *signature*, which changes with every
 * build. So the microphone, the audio tap and notifications are all forgotten each
 * time the app updates itself. That is not a bug to be hidden; it is a fact the
 * update has to hand back to the person using it, which is why the screen that says
 * what changed is the same screen that asks for the three permissions back.
 *
 * `signature` below is how the app knows, rather than assumes: a real signature the
 * day there is one makes the whole permissions panel disappear on its own.
 */

/** Where the builds come from. One place, so nothing can point at a second repo. */
export const UPDATE_REPO = 'Johannett321/neo'

/**
 * Where a release is described. `/latest` rather than `/releases`: GitHub already
 * excludes drafts and pre-releases from it, so there is no channel to get wrong.
 */
export const UPDATE_FEED = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`

/** The page a person is sent to when this machine cannot update itself. */
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`

/**
 * How much the app is allowed to do by itself.
 *
 * `off` means **no request**, not a request whose answer is ignored — the same rule
 * the weather is held to, and asserted the same way.
 */
export type UpdatePreference = 'automatic' | 'notify' | 'off'

/**
 * Where the update stands.
 *
 * `unsupported` is not a failure: a development run, a Linux build outside an
 * AppImage and an app in a folder this account cannot write to are all copies of
 * Neo that must not try to replace themselves. They say so and offer the download
 * page instead.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  /** What this machine is running. */
  current: string
  /** What is waiting, when something is. Empty otherwise. */
  version: string
  /** What that release says about itself — the release body, as Markdown. */
  notes: string
  /** How far the download has got, 0 to 1. Zero unless the phase is `downloading`. */
  progress: number
  /** How big it is, in bytes. Zero until a download has started. */
  bytes: number
  /** Why not, in words somebody can act on. Empty unless something went wrong. */
  reason: string
  /** When the last check finished, as an ISO timestamp. Empty until one has. */
  checkedAt: string
}

/**
 * One released version, as it ships with the app.
 *
 * The changelog is a folder of Markdown files in the repository rather than
 * something fetched: it is bundled, so the screen that says what changed works with
 * no network, and its screenshots are files beside it rather than links that rot.
 * The release notes on GitHub are generated *from* these files at tag time, so
 * there is one description of a release and not two.
 */
export interface ChangelogEntry {
  version: string
  /** The headline. Falls back to the version when the file does not give one. */
  title: string
  /** `YYYY-MM-DD`, or empty. */
  date: string
  /**
   * Markdown, rendered by the app's own parser. Illustrations are written as
   * ordinary image syntax and rewritten to `neo-media://changelog/…` on the way
   * out, so a changelog can be as plain or as pictorial as the release deserves.
   */
  body: string
}

export type PermissionName = 'microphone' | 'systemAudio' | 'notifications'

/**
 * `unknown` is the honest answer far more often than it looks.
 *
 * macOS will not tell an application whether it may show a notification, and there
 * is no API at all for asking about an audio tap — for both, trying *is* the ask.
 * Only the microphone can be read without doing anything.
 */
export type PermissionState = 'granted' | 'denied' | 'unknown' | 'unavailable'

export interface PermissionReport {
  name: PermissionName
  state: PermissionState
  /** Empty unless there is something worth saying. */
  reason: string
}

export interface UpdateCapability {
  /** Whether this copy can replace itself at all. */
  canSelfUpdate: boolean
  /** Why not, when it cannot. Empty otherwise. */
  reason: string
  /**
   * Whether updating this copy will make macOS forget its privacy permissions —
   * true exactly when the bundle is ad-hoc signed. Read from the signature rather
   * than assumed, so a real Developer ID silently retires the whole panel.
   */
  resetsPermissions: boolean
}
