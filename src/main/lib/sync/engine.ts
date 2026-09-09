import type { RowChange } from '@shared/tables'
import type { SyncBilling, SyncStatus } from '@shared/sync'
import { NO_BILLING, OFFLINE_AFTER_MS, POLL_INTERVAL_MS } from '@shared/sync'
import { q, q1, exec } from '../../db/client'
import { applyRun } from '../../db/apply'
import { pendingCount, settle, waiting, workspacesWaiting } from '../../db/dirty'
import { onLocalWrite } from '../../db/wake'
import { announceChange } from '../changes'
import { pullBlobs, pushBlobs } from './blobs'
import { Relay, RelayError, isOffline } from './relay'

/**
 * The runner that keeps this machine and the sync server in step.
 *
 * The shape is the recording pipeline's: a loop over rows with its state in the
 * database rather than in memory, so a crash costs a pass rather than a position.
 *
 * **The server is the authority and this machine is a full replica.** Every read the
 * app makes comes out of the database in `~/.neo`, which is why Neo works with no
 * account at all and why closing the laptop lid changes nothing. What connecting adds
 * is a canonical copy: when two devices disagree, the server's answer is the one that
 * survives, and it is where a lost Mac is restored from.
 *
 * Nothing here decides what is true — `apply.ts` does that, and it applies a row from
 * the server exactly as it applies a click.
 */

/* ------------------------------------------------------------------ *
 * What this device remembers
 * ------------------------------------------------------------------ */

const setting = async (key: string): Promise<string> => {
  const row = await q1<{ value: string }>('SELECT value FROM setting WHERE key = $1', [key])
  return row?.value ?? ''
}

const putSetting = async (key: string, value: string): Promise<void> => {
  await exec(
    `INSERT INTO setting (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  )
}

const KEYS = {
  url: 'syncServerUrl',
  token: 'syncToken',
  handle: 'syncHandle',
  accountId: 'syncAccountId',
  deviceName: 'syncDeviceName'
} as const

/* ------------------------------------------------------------------ *
 * State held only while the app is running
 * ------------------------------------------------------------------ */

let relay: Relay | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let stopping = false

/** The one live connection, and whether it is actually up. */
let stream: AbortController | null = null
let live = false
/** Undoes the subscription to local writes. Held so a disconnect really disconnects. */
let unwatch: (() => void) | null = null

/**
 * A pass was asked for while one was running, and whether it wants the full one.
 *
 * Coalescing rather than dropping: a change announced while this device happened to
 * be busy would otherwise wait for the next minute.
 */
let again = false
let againFull = false

/** When the last full pull and the last file pass were, so a burst can skip both. */
let lastFullPull = 0
let lastFilePass = 0

let phase: SyncStatus['phase'] = 'off'
let lastError = ''
let lastSyncedAt = ''
/** When the server first stopped answering. Zero while it is answering. */
let unreachableSince = 0
let storage = { uploaded: 0, overQuota: 0, waiting: 0 }
let space = { used: 0, quota: 0 }
let money: SyncBilling = NO_BILLING

/* ------------------------------------------------------------------ *
 * Connecting
 * ------------------------------------------------------------------ */

export async function saveConnection(
  serverUrl: string, token: string, accountId: string, handle: string, deviceName: string
): Promise<void> {
  await putSetting(KEYS.url, serverUrl.replace(/\/+$/, ''))
  await putSetting(KEYS.token, token)
  await putSetting(KEYS.accountId, accountId)
  await putSetting(KEYS.handle, handle)
  await putSetting(KEYS.deviceName, deviceName)
  relay = null
}

/**
 * Forget the account, on this machine only.
 *
 * The rows stay exactly where they are and the app carries on as Local. What goes is
 * the token, the cursors and the device's claim on the server — the button means "not
 * from here", never "destroy my backup".
 */
export async function disconnect(): Promise<void> {
  await stop()
  relay = null
  money = NO_BILLING
  phase = 'off'
  for (const key of Object.values(KEYS)) await exec('DELETE FROM setting WHERE key = $1', [key])
  await exec('DELETE FROM sync_state')
}

async function connectRelay(): Promise<Relay | null> {
  const url = await setting(KEYS.url)
  const token = await setting(KEYS.token)
  if (!url || !token) return null
  if (!relay) relay = new Relay(url, token)
  return relay
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

/**
 * Push first, then pull.
 *
 * In that order on purpose: what this machine has written and not handed over is the
 * thing most at risk of being lost, so it leaves before anything is taken in. It also
 * makes the conflict rule behave the way somebody would expect — a device that has
 * been closed for a week hands over its week of work and *then* hears about
 * everybody else's, rather than being overwritten before it has spoken.
 *
 * A pass that fails half way has still moved everything it moved: the marks are
 * cleared behind rows that actually landed, and the cursors advance behind pages that
 * actually applied.
 */
export async function syncNow(full = true): Promise<void> {
  if (running) {
    // Not dropped: remembered, and run once this pass is out of the way.
    again = true
    againFull = againFull || full
    return
  }
  const client = await connectRelay()
  if (!client) return

  running = true
  try {
    let wanted = full
    for (;;) {
      again = false
      againFull = false
      const ok = await pass(client, wanted)
      if (!ok || !again || stopping) break
      wanted = againFull
    }
  } finally {
    running = false
  }
}

/**
 * One pass. Returns false if it ended badly, which is what stops a coalesced retry
 * from becoming a tight loop against a server that is down.
 *
 * Two things are skipped when this was woken by a local write rather than by the
 * clock or by the server: the pull, and the files. Neither can have anything new in
 * it — nobody else has said anything — and doing them anyway would put a round trip
 * per workspace and a `stat()` per file behind every keystroke that autosaves.
 */
async function pass(client: Relay, full: boolean): Promise<boolean> {
  phase = 'syncing'
  try {
    /*
     * An unpaid account is refused *sending* and nothing else, which is why this is
     * caught rather than thrown. Receiving carries on, files already up here can
     * still be fetched, and the whole of what changes is that this machine stops
     * handing new work over — so the pass reports success and the pane says why.
     */
    let blocked = false
    let sent = 0
    try {
      sent = await push(client)
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 402) throw error
      blocked = true
      money = { ...money, mayWrite: false }
    }

    const now = Date.now()
    const pullDue = full || now - lastFullPull >= POLL_INTERVAL_MS
    const moved = pullDue ? await pullAll(client) : 0
    if (pullDue) lastFullPull = now

    /*
     * Files after rows, in both directions, and that order is the whole of it. A file
     * is only worth moving because something refers to it, and the reference is in a
     * row — so the rows have to land first or this would be fetching against a list
     * it has not been told about yet.
     */
    if (sent > 0 || moved > 0 || now - lastFilePass >= POLL_INTERVAL_MS) {
      try {
        const out = blocked ? { uploaded: 0, skipped: 0 } : await pushBlobs(client)
        const got = await pullBlobs(client)
        storage = { uploaded: out.uploaded, overQuota: out.skipped, waiting: got.missing }
        if (got.fetched > 0) announceChange()
      } catch (error) {
        /*
         * A server with no bucket is a perfectly good sync server: the rows are the
         * whole of syncing and files are separate and lazy by design. Somebody
         * self-hosting for text alone, or running one on a laptop, should not have
         * every pass report a failure — so this is noted and the pass succeeds.
         */
        if (!(error instanceof RelayError) || error.status !== 503) throw error
        storage = { uploaded: 0, overQuota: 0, waiting: 0 }
      }
      lastFilePass = now
    }

    lastSyncedAt = new Date().toISOString()
    lastError = ''
    unreachableSince = 0
    phase = 'idle'
    if (moved > 0) announceChange()
    return true
  } catch (error) {
    /*
     * Unreachable is not an error, and keeping the two apart is most of what makes
     * the badge honest. A network that is not there says so in a sentence nobody
     * needs to read; the pane says "Offline" and everything goes on working.
     */
    if (isOffline(error)) {
      if (!unreachableSince) unreachableSince = Date.now()
      phase = Date.now() - unreachableSince >= OFFLINE_AFTER_MS ? 'offline' : 'idle'
      return false
    }
    phase = 'error'
    lastError = error instanceof Error ? error.message : String(error)
    if (error instanceof RelayError && error.needsSignIn) {
      // The token has been revoked, or the account is gone. There is nothing this
      // device can usefully do until somebody signs in again.
      phase = 'error'
    }
    return false
  }
}

/**
 * Hand over what this device has changed, a workspace at a time.
 *
 * Returns how many rows went out, which is what decides whether files are due.
 */
async function push(client: Relay): Promise<number> {
  let sent = 0
  for (const workspaceId of await workspacesWaiting()) {
    for (;;) {
      const page = await waiting(workspaceId, PUSH_PAGE)
      if (page.length === 0) break
      const changes: RowChange[] = page.map(({ workspaceId: _ignored, ...change }) => change)
      await client.push(workspaceId, changes)
      // Only after the server has it. A mark cleared before the request landed is
      // work this device would never think to offer again.
      await settle(changes)
      sent += changes.length
      if (page.length < PUSH_PAGE) break
    }
  }
  return sent
}

/** Big enough that a first sync is tens of requests, small enough to repeat cheaply. */
const PUSH_PAGE = 500
const PULL_PAGE = 500

async function pullAll(client: Relay): Promise<number> {
  const account = await client.account()
  space = { used: account.usedBytes, quota: account.quotaBytes }
  money = { ...NO_BILLING, ...(account.billing ?? {}) }

  let applied = 0
  for (const workspace of account.workspaces) {
    applied += await pull(client, workspace.workspaceId)
  }
  return applied
}

async function pull(client: Relay, workspaceId: string): Promise<number> {
  let applied = 0

  for (;;) {
    const row = await q1<{ remote_rev: string }>(
      'SELECT remote_rev FROM sync_state WHERE workspace_id = $1', [workspaceId]
    )
    const since = Number(row?.remote_rev ?? 0)
    const page = await client.pull(workspaceId, since, PULL_PAGE)
    if (page.changes.length === 0) return applied

    const changes: RowChange[] = page.changes.map((change) => {
      /*
       * Only the three columns the server added come off. `workspace_id` deliberately
       * stays: most of these tables have one of their own and it is NOT NULL, so
       * taking it off would make every project, person and conversation arrive as a
       * row that cannot be inserted. The one table where it is not a real column is
       * `workspace` itself, and `applyRemote` drops it there because it asks the
       * database what the columns are rather than assuming.
       */
      const { rev: _rev, changed_at: changedAt, deleted_at: deletedAt, ...fields } =
        change.row as Record<string, unknown>
      return {
        table: change.table as RowChange['table'],
        id: String(fields.id),
        deleted: deletedAt != null,
        changedAt: String(changedAt),
        fields
      }
    })

    const result = await applyRun(changes)
    applied += result.applied

    /*
     * The cursor advances over the whole page, including rows that were correctly
     * skipped and rows that could not be placed. A page is ordered by revision, so a
     * row that could not be placed once everything after it had been tried is
     * describing a branch that is gone — and refusing to move past it would strand
     * the workspace on one row for ever.
     */
    const head = Math.max(...page.changes.map((change) => change.rev))
    await exec(
      `INSERT INTO sync_state (workspace_id, remote_rev, synced_at) VALUES ($1, $2, now())
       ON CONFLICT (workspace_id)
       DO UPDATE SET remote_rev = EXCLUDED.remote_rev, synced_at = now()`,
      [workspaceId, head]
    )
    if (!page.more) return applied
  }
}

/* ------------------------------------------------------------------ *
 * Living
 * ------------------------------------------------------------------ */

/**
 * How long a burst of writing is allowed to gather before it is sent.
 *
 * A note being typed autosaves repeatedly, and each save marks rows. Waiting for a
 * short quiet gives one push instead of a dozen; the cap stops continuous typing from
 * deferring the send for ever, which is the failure mode of a plain debounce.
 */
const WAKE_QUIET_MS = 400
const WAKE_AT_MOST_MS = 2_000

let wakeTimer: NodeJS.Timeout | null = null
let wakeSince = 0

/**
 * "There is something to do." Called when this device writes, and by the stream when
 * the server says another device did.
 *
 * A local write only needs pushing, so the pass it asks for is the cheap one; an
 * event from the server means something is there to fetch, so that one is full.
 */
function wake(full: boolean): void {
  if (stopping) return
  const now = Date.now()
  if (!wakeSince) wakeSince = now
  if (wakeTimer) clearTimeout(wakeTimer)

  const wanted = full || againFull
  againFull = wanted
  const delay = Math.max(0, Math.min(WAKE_QUIET_MS, wakeSince + WAKE_AT_MOST_MS - now))
  wakeTimer = setTimeout(() => {
    wakeTimer = null
    wakeSince = 0
    void syncNow(wanted)
  }, delay)
  wakeTimer.unref?.()
}

export async function start(): Promise<void> {
  stopping = false
  const client = await connectRelay()
  if (!client) {
    phase = 'off'
    return
  }

  // Writing is what makes a push urgent, and the database is the only thing that
  // knows a write happened. Without this the fastest a change could leave was the poll.
  if (!unwatch) unwatch = onLocalWrite(() => wake(false))

  phase = 'connecting'
  await syncNow()
  listen(client)

  // The poll is the floor, not the mechanism. The stream is what makes a change on
  // the other Mac appear in about a second; this is what makes it appear at all when
  // a proxy has quietly eaten the connection.
  if (!timer) timer = setInterval(() => void syncNow(), POLL_INTERVAL_MS)
}

/** How long to wait before reopening a stream that dropped, and the ceiling on it. */
const RETRY_MS = 1_000
const RETRY_CEILING_MS = 30_000

/**
 * Hold the stream open, and keep holding it.
 *
 * The connection is expected to break — a laptop closes, a proxy times out, a deploy
 * restarts the server — so the loop is the feature and the connection is the detail.
 * Without it a single drop silently demoted this device to the minute poll and only a
 * restart brought it back, which is indistinguishable from "syncing is slow today".
 */
function listen(client: Relay): void {
  if (stream) return
  const controller = new AbortController()
  stream = controller

  void (async () => {
    let backoff = RETRY_MS
    while (!stopping && stream === controller) {
      try {
        for await (const _event of client.stream(controller.signal, () => {
          live = true
          backoff = RETRY_MS
          unreachableSince = 0
        })) {
          // What moved is not read: the cursor in this database says what to ask for,
          // and asking is the same code the poll uses.
          wake(true)
        }
      } catch (error) {
        /*
         * Dropped, refused, or aborted. Which of those it was does not change what
         * happens next — reconnect, and the poll covers the gap meanwhile — so it is
         * behind a flag rather than in the log. Being aborted is not a failure at
         * all: that is this process shutting down.
         */
        if (process.env.PM_TRACE_SYNC && !controller.signal.aborted) {
          console.error('The live stream ended:', error)
        }
      }
      live = false
      if (stopping || controller.signal.aborted) break
      await naptime(backoff, controller.signal)
      backoff = Math.min(backoff * 2, RETRY_CEILING_MS)
    }
    live = false
    if (stream === controller) stream = null
  })()
}

/** Sleep, unless the thing that would have woken us has been called off. */
function naptime(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    timeout.unref?.()
  })
}

export async function stop(): Promise<void> {
  stopping = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  wakeSince = 0
  unwatch?.()
  unwatch = null
  stream?.abort()
  stream = null
  live = false
}

/* ------------------------------------------------------------------ *
 * Saying what is going on
 * ------------------------------------------------------------------ */

export async function status(): Promise<SyncStatus> {
  const serverUrl = await setting(KEYS.url)

  if (!serverUrl) {
    return {
      phase: 'off', serverUrl: '', accountHandle: '', deviceName: '', error: '',
      lastSyncedAt: '', pending: 0, live: false, filesWaiting: 0, filesOverQuota: 0,
      usedBytes: 0, quotaBytes: 0, billing: NO_BILLING, workspaces: []
    }
  }

  const workspaces = await q<{ id: string; name: string; remote_rev: string }>(
    `SELECT w.id, w.name, COALESCE(s.remote_rev, 0) AS remote_rev
       FROM workspace w LEFT JOIN sync_state s ON s.workspace_id = w.id
      WHERE w.archived_at IS NULL ORDER BY w.sort_order, w.name`
  )

  return {
    phase,
    serverUrl,
    accountHandle: await setting(KEYS.handle),
    deviceName: await setting(KEYS.deviceName),
    error: lastError,
    lastSyncedAt,
    pending: await pendingCount(),
    live: live && !stopping,
    filesWaiting: storage.waiting,
    filesOverQuota: storage.overQuota,
    usedBytes: space.used,
    quotaBytes: space.quota,
    billing: money,
    workspaces: workspaces.map((w) => ({
      workspaceId: w.id, name: w.name, remoteRev: Number(w.remote_rev)
    }))
  }
}

/** Whether this machine is signed in to a sync server at all. */
export const isConnected = (): boolean => phase !== 'off'

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * What the sync server says a subscription costs, asked only when the settings pane
 * is open. Everything else about billing arrives with the account on every pass.
 */
export async function prices(): Promise<SyncBilling> {
  const client = await connectRelay()
  if (!client) return NO_BILLING
  try {
    money = { ...money, ...(await client.billing()) }
  } catch {
    // The pane still has what the last pass brought back, which is everything except
    // the two prices. A row that says "9 USD" wrongly would be worse than one absent.
  }
  return money
}

/**
 * A link to Stripe, for the person's own browser.
 *
 * Deliberately not a window Neo owns. A payment page inside the app is a payment page
 * whose address bar nobody can see, which is the one thing everybody is told to check.
 */
export async function payLink(kind: 'monthly' | 'yearly' | 'manage'): Promise<string> {
  const client = await connectRelay()
  if (!client) throw new Error('This machine is not connected to a sync server.')
  const result = kind === 'manage' ? await client.portal() : await client.checkout(kind)
  return result.url
}
