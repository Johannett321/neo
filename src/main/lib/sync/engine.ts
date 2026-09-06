import { safeStorage } from 'electron'
import type { SyncStatus } from '@shared/sync'
import { POLL_INTERVAL_MS } from '@shared/sync'
import { q, q1, exec } from '../../db/client'
import { ingest, pending, pendingCount } from '../../db/oplog'
import { announceChange } from '../changes'
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
const streams = new Map<string, AbortController>()

let phase: SyncStatus['phase'] = 'off'
let lastError = ''
let lastSyncedAt = ''

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
export async function syncNow(): Promise<void> {
  if (running || !master) return
  const client = await connectRelay()
  if (!client) return

  running = true
  phase = 'syncing'
  try {
    await push(client)
    const moved = await pullAll(client)
    lastSyncedAt = new Date().toISOString()
    lastError = ''
    phase = 'idle'
    if (moved > 0) announceChange()
  } catch (error) {
    phase = 'error'
    lastError = error instanceof Error ? error.message : String(error)
    if (error instanceof RelayError && error.needsSignIn) {
      // The token has been revoked, or the account is gone. Holding the key in
      // memory past that point would be pretending this still works.
      master = null
      phase = 'locked'
    }
  } finally {
    running = false
  }
}

async function push(client: Relay): Promise<void> {
  if (!master) return

  for (;;) {
    const cursor = (await setting(KEYS.pushed)) || '0'
    const batches = await pending(cursor, 50)
    if (batches.length === 0) return

    for (const batch of batches) {
      // A batch belonging to no workspace has nothing to be sealed under and no
      // stream to go to. It is skipped rather than retried forever.
      if (batch.workspaceId) {
        const sealed = seal(workspaceKey(master, batch.workspaceId), batchToWire(batch))
        await client.push(batch.workspaceId, batch.id, sealed)
      }
      await putSetting(KEYS.pushed, batch.seq)
    }
  }
}

async function pullAll(client: Relay): Promise<number> {
  const account = await client.account()
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

  phase = 'idle'
  await syncNow()
  await listen(client)

  // The poll is the floor, not the mechanism. The stream is what makes a change on
  // the other Mac appear in seconds; this is what makes it appear at all when a
  // proxy has quietly eaten the connection.
  if (!timer) timer = setInterval(() => void syncNow(), POLL_INTERVAL_MS)
}

async function listen(client: Relay): Promise<void> {
  const account = await client.account()
  for (const workspace of account.workspaces) {
    if (streams.has(workspace.workspaceId)) continue
    const controller = new AbortController()
    streams.set(workspace.workspaceId, controller)

    void (async () => {
      try {
        for await (const _seq of client.stream(workspace.workspaceId, controller.signal)) {
          void syncNow()
        }
      } catch {
        // Dropped. The poll covers it, and the next `start()` reopens it.
      } finally {
        streams.delete(workspace.workspaceId)
      }
    })()
  }
}

export async function stop(): Promise<void> {
  stopping = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  for (const controller of streams.values()) controller.abort()
  streams.clear()
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
      lastSyncedAt: '', pending: 0, live: false, workspaces: []
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
    live: streams.size > 0 && !stopping,
    workspaces: workspaces.map((w) => ({
      workspaceId: w.id, name: w.name, remoteSeq: Number(w.remote_seq)
    }))
  }
}

export const isUnlocked = (): boolean => master !== null
