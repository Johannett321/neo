import { safeStorage } from 'electron'
import type { SyncBilling, SyncStatus } from '@shared/sync'
import { NO_BILLING, POLL_INTERVAL_MS } from '@shared/sync'
import { q, q1, exec } from '../../db/client'
import { ingest, onLocalWrite, pending, pendingCount } from '../../db/oplog'
import { announceChange } from '../changes'
import { pullBlobs, pushBlobs } from './blobs'
import { Relay, RelayError, batchToWire, wireToBatch } from './relay'
import { newMasterKey, open, seal, unwrapMasterKey, workspaceKey, wrapMasterKey } from './crypto'

/**
 * The runner that keeps this machine and the server in step.
 *
 * The shape is the recording pipeline's: a loop over rows with its state in the
 * database rather than in memory, so a crash costs a pass rather than a position.
 * Nothing here decides what is true — the log does that, and `apply()` resolves it.
 * This only moves sealed bytes in two directions.
 *
 * Local and synced are the same code path with this attached or not attached. There
 * is deliberately no second way to write anything.
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
  deviceName: 'syncDeviceName',
  pushed: 'syncPushedSeq',
  /** The master key, sealed by the OS keychain. Never the passphrase. */
  cached: 'syncCachedKey'
} as const

/* ------------------------------------------------------------------ *
 * State held only while the app is running
 * ------------------------------------------------------------------ */

let master: Buffer | null = null
let relay: Relay | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let stopping = false

/** The one live connection, and whether it is actually up. */
let stream: AbortController | null = null
let live = false
/** Undoes the subscription to the log. Held so a disconnect really disconnects. */
let unwatch: (() => void) | null = null

/**
 * A pass was asked for while one was running, and whether it wants the full one.
 *
 * Coalescing rather than dropping. The old guard returned early if a pass was in
 * flight, which is fine for a timer and wrong for an event: a change announced while
 * this device happened to be busy waited for the next minute.
 */
let again = false
let againFull = false

/** When the last full pull and the last file pass were, so a burst can skip both. */
let lastFullPull = 0
let lastFilePass = 0

let phase: SyncStatus['phase'] = 'off'
let lastError = ''
let lastSyncedAt = ''
let storage = { uploaded: 0, overQuota: 0, waiting: 0 }
let space = { used: 0, quota: 0 }
let money: SyncBilling = NO_BILLING

/**
 * Whether this account has ever had a passphrase set, which is the only honest way to
 * know whether this machine is setting one or typing one it already has. Null until
 * asked; unknown counts as first, because asking twice on a machine that did not need
 * it costs a moment and getting it the other way round sets a passphrase by typo.
 */
let accountHasKey: boolean | null = null

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
}

/**
 * Take the passphrase, and end up holding the master key.
 *
 * Two cases, and which one it is depends on whether this account has ever been used
 * rather than on anything the person has to answer. A new account seals a fresh
 * random key under the passphrase and stores the wrapped form on the server. An
 * existing one fetches that wrapped form and opens it — so a second Mac typing the
 * same passphrase arrives at the same key without either machine sending it.
 */
export async function unlock(passphrase: string): Promise<{ ok: boolean; reason?: string }> {
  const client = await connectRelay()
  if (!client) return { ok: false, reason: 'This machine is not connected to a sync server.' }

  const { keyMaterial } = await client.keyMaterial()
  const existing = keyMaterial.passphrase
  accountHasKey = Boolean(existing)

  if (existing) {
    const opened = unwrapMasterKey(JSON.parse(existing), passphrase)
    if (!opened) {
      return { ok: false, reason: 'That is not the passphrase this account was set up with.' }
    }
    master = opened
  } else {
    /*
     * First device on this account. The key is random and the passphrase only wraps
     * it, so changing the passphrase later re-wraps rather than re-encrypting
     * everything — and a weak passphrase costs the wrapping rather than the data.
     */
    master = newMasterKey()
    await client.putKeyMaterial('passphrase', JSON.stringify(wrapMasterKey(master, passphrase)))
  }

  await cacheKey(master)
  accountHasKey = true
  phase = 'idle'
  lastError = ''
  return { ok: true }
}

/**
 * Remember the master key across restarts, in the OS keychain rather than in the
 * database.
 *
 * The alternative is asking for the passphrase on every launch, which teaches people
 * to choose one they can type quickly. `safeStorage` puts it behind the login
 * keychain, so a copied `~/.neo` on somebody else's machine opens nothing.
 */
async function cacheKey(key: Buffer): Promise<void> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return
    await putSetting(KEYS.cached, safeStorage.encryptString(key.toString('base64')).toString('base64'))
  } catch {
    // No keychain: the passphrase is asked for each launch, which still works.
  }
}

async function loadCachedKey(): Promise<boolean> {
  try {
    const stored = await setting(KEYS.cached)
    if (!stored || !safeStorage.isEncryptionAvailable()) return false
    const value = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    master = Buffer.from(value, 'base64')
    return master.length === 32
  } catch {
    return false
  }
}

/** Forget everything about the account, on this machine only. */
export async function disconnect(): Promise<void> {
  await stop()
  master = null
  relay = null
  money = NO_BILLING
  accountHasKey = null
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
 * In that order on purpose: what this machine has already written is the thing most
 * at risk of being lost, so it leaves before anything else is taken in. A pass that
 * fails half way has still moved everything it moved — the cursors only advance
 * behind work that actually landed.
 */
export async function syncNow(full = true): Promise<void> {
  if (!master) return
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
 * per workspace and a `stat()` per file behind every keystroke that autosaves. They
 * still happen on the poll, and immediately whenever the stream says something moved.
 */
async function pass(client: Relay, full: boolean): Promise<boolean> {
  if (!master) return false
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
     * Files after rows, in both directions, and that order is the whole of it. A
     * file is only worth moving because something refers to it, and the reference
     * is in the log — so the rows have to land first or this would be fetching
     * against a list it has not been told about yet.
     */
    if (sent > 0 || moved > 0 || now - lastFilePass >= POLL_INTERVAL_MS) {
      const out = blocked
        ? { uploaded: 0, skipped: 0 }
        : await pushBlobs(client, master)
      const got = await pullBlobs(client, master)
      storage = { uploaded: out.uploaded, overQuota: out.skipped, waiting: got.missing }
      lastFilePass = now
      if (got.fetched > 0) announceChange()
    }

    lastSyncedAt = new Date().toISOString()
    lastError = ''
    phase = 'idle'
    if (moved > 0) announceChange()
    return true
  } catch (error) {
    phase = 'error'
    lastError = error instanceof Error ? error.message : String(error)
    if (error instanceof RelayError && error.needsSignIn) {
      // The token has been revoked, or the account is gone. Holding the key in
      // memory past that point would be pretending this still works.
      master = null
      phase = 'locked'
    }
    return false
  }
}

/** Returns how many batches went out, which is what decides whether files are due. */
async function push(client: Relay): Promise<number> {
  if (!master) return 0
  let sent = 0

  for (;;) {
    const cursor = (await setting(KEYS.pushed)) || '0'
    const batches = await pending(cursor, 50)
    if (batches.length === 0) return sent

    for (const batch of batches) {
      // A batch belonging to no workspace has nothing to be sealed under and no
      // stream to go to. It is skipped rather than retried forever.
      if (batch.workspaceId) {
        const sealed = seal(workspaceKey(master, batch.workspaceId), batchToWire(batch))
        await client.push(batch.workspaceId, batch.id, sealed)
        sent += 1
      }
      await putSetting(KEYS.pushed, batch.seq)
    }
  }
}

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
  if (!master) return 0
  const key = workspaceKey(master, workspaceId)
  let applied = 0

  for (;;) {
    const row = await q1<{ remote_seq: string }>(
      'SELECT remote_seq FROM sync_state WHERE workspace_id = $1', [workspaceId]
    )
    const since = Number(row?.remote_seq ?? 0)
    const page = await client.pull(workspaceId, since)
    if (page.batches.length === 0) return applied

    for (const remote of page.batches) {
      try {
        const batch = wireToBatch(open(key, remote.ciphertext).toString('utf8'))
        const result = await ingest(batch)
        applied += result.applied
      } catch (error) {
        /*
         * A batch this device cannot open is the one thing here that must not stop
         * the stream. It means a different passphrase wrote it, or it is damaged;
         * either way every batch behind it is still readable and refusing to move
         * past it would strand the whole workspace on one bad row.
         */
        console.warn(`Skipping batch ${remote.batchId}: ${String(error)}`)
      }
      await exec(
        `INSERT INTO sync_state (workspace_id, remote_seq, synced_at) VALUES ($1, $2, now())
         ON CONFLICT (workspace_id)
         DO UPDATE SET remote_seq = EXCLUDED.remote_seq, synced_at = now()`,
        [workspaceId, remote.seq]
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * Living
 * ------------------------------------------------------------------ */

/**
 * How long a burst of writing is allowed to gather before it is sent.
 *
 * A note being typed autosaves repeatedly, and each save is a batch. Waiting for a
 * short quiet gives one push instead of a dozen; the cap stops continuous typing from
 * deferring the send forever, which is the failure mode of a plain debounce.
 */
const WAKE_QUIET_MS = 400
const WAKE_AT_MOST_MS = 2_000

let wakeTimer: NodeJS.Timeout | null = null
let wakeSince = 0

/**
 * "There is something to do." Called by the log when this device writes, and by the
 * stream when the server says another device did.
 *
 * A local write only needs pushing, so the pass it asks for is the cheap one; an
 * event from the server means something is there to fetch, so that one is full.
 */
function wake(full: boolean): void {
  if (!master || stopping) return
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
  if (!master && !(await loadCachedKey())) {
    phase = 'locked'
    return
  }

  // Writing is what makes a push urgent, and the log is the only thing that knows a
  // write happened. Without this the fastest a change could leave was the poll.
  if (!unwatch) unwatch = onLocalWrite(() => wake(false))

  phase = 'idle'
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
        })) {
          // What moved is not read: the cursor in this database says what to ask
          // for, and asking is the same code the poll uses.
          wake(true)
        }
      } catch (error) {
        /*
         * Dropped, refused, or aborted. Which of those it was does not change what
         * happens next — reconnect, and the poll covers the gap meanwhile — so it is
         * behind a flag rather than in the log, the way `PM_TRACE_DROPS` is. Being
         * aborted is not a failure at all: that is this process shutting down.
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
  const handle = await setting(KEYS.handle)

  if (!serverUrl) {
    return {
      phase: 'off', serverUrl: '', accountHandle: '', deviceName: '', error: '',
      lastSyncedAt: '', pending: 0, live: false, filesWaiting: 0, filesOverQuota: 0,
      usedBytes: 0, quotaBytes: 0, firstDevice: true, billing: NO_BILLING, workspaces: []
    }
  }

  /*
   * Asked once, and only while locked — which is the one moment the answer changes
   * what is on screen. It used to be guessed from "does this Mac have workspaces",
   * which is a different question with the same answer on exactly one machine.
   */
  if (accountHasKey === null && phase === 'locked') {
    const client = await connectRelay()
    if (client) {
      try {
        accountHasKey = Boolean((await client.keyMaterial()).keyMaterial.passphrase)
      } catch {
        // Left unknown, which reads as "first device" and asks for it twice.
      }
    }
  }

  const workspaces = await q<{ id: string; name: string; remote_seq: string }>(
    `SELECT w.id, w.name, COALESCE(s.remote_seq, 0) AS remote_seq
       FROM workspace w LEFT JOIN sync_state s ON s.workspace_id = w.id
      WHERE w.archived_at IS NULL ORDER BY w.sort_order, w.name`
  )

  return {
    phase: master ? phase : phase === 'off' ? 'locked' : phase,
    serverUrl,
    accountHandle: handle,
    deviceName: await setting(KEYS.deviceName),
    error: lastError,
    lastSyncedAt,
    pending: await pendingCount((await setting(KEYS.pushed)) || '0'),
    live: live && !stopping,
    filesWaiting: storage.waiting,
    filesOverQuota: storage.overQuota,
    usedBytes: space.used,
    quotaBytes: space.quota,
    firstDevice: accountHasKey !== true,
    billing: money,
    workspaces: workspaces.map((w) => ({
      workspaceId: w.id, name: w.name, remoteSeq: Number(w.remote_seq)
    }))
  }
}

export const isUnlocked = (): boolean => master !== null

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
