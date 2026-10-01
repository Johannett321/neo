import { BrowserWindow } from 'electron'
import type { Channel } from '@shared/api'
import { isSyncable, type QueuedWrite, type SubmitResult, type SyncState } from '@shared/sync'
import { announceChange } from '../changes'
import { invokeChannel } from '../../ipc/util'
import { CloudError } from './client'
import { forgetIds, knownIds, loadIds, rememberId, resolveIds } from './ids'
import { isReachable, onReachability } from './reachability'
import { loadSession } from './session'
import { listSealed, readSealed, removeSealed, writeSealed } from './sealed'

/**
 * The writes waiting for Neo Cloud, in the order they were made.
 *
 * Every write the window draws before Neo Cloud has answered (`shared/sync.ts`) comes
 * through here, online or not — so there is one line, and a create and the edit made
 * to it a moment later can never pass each other. The head is sent; when it lands the
 * next one goes. If Neo Cloud cannot be reached the line stops where it is, sealed on
 * disk under the account it belongs to, and starts again the moment anything gets
 * through (`reachability.ts`) or the retry timer comes round.
 *
 * A write Neo Cloud *refuses* is a different thing from one it never heard. A refusal
 * that somebody is still waiting on — a click a moment ago — is thrown back to them,
 * and the window undoes what it drew and says so. A refusal of a write made while
 * offline has nobody waiting: it is kept in `failed`, the window lists it, and the
 * person retries or discards it. Either way the line moves on: one refused write does
 * not hold back everything behind it.
 */

const PREFIX = 'neo-outbox-'
const RETRY_MS = 2_000
const RETRY_CEILING_MS = 30_000
/** Enough for any screen still holding a temporary id; old pairings are worthless. */
const IDS_KEPT = 500

interface Stored {
  accountId: string
  pending: QueuedWrite[]
  failed: QueuedWrite[]
  ids: Record<string, string>
}

let loadedFor: string | null = null
let pending: QueuedWrite[] = []
let failed: QueuedWrite[] = []
let draining = false
/** A write went without anybody waiting on it, so the window has catching up to do. */
let replayed = false
let backoff = RETRY_MS
let timer: ReturnType<typeof setTimeout> | null = null

/** In memory only: the window that made a write and is waiting to hear what became of it. */
const waiters = new Map<string, { resolve: (r: SubmitResult) => void; reject: (e: unknown) => void }>()

const fileFor = (accountId: string): string => `${PREFIX}${accountId}`

/** Pick up whatever the signed-in account left waiting, once per account. */
function ensureLoaded(): void {
  const accountId = loadSession()?.accountId ?? null
  if (accountId === loadedFor) return
  pending = []
  failed = []
  forgetIds()
  loadedFor = accountId
  if (!accountId) return
  const stored = readSealed<Stored>(fileFor(accountId))
  if (stored && stored.accountId === accountId) {
    pending = stored.pending ?? []
    failed = stored.failed ?? []
    loadIds(stored.ids)
  }
}

function persist(): void {
  if (!loadedFor) return
  const ids = Object.fromEntries(Object.entries(knownIds()).slice(-IDS_KEPT))
  if (pending.length === 0 && failed.length === 0 && Object.keys(ids).length === 0) {
    removeSealed(fileFor(loadedFor))
    return
  }
  writeSealed(fileFor(loadedFor), { accountId: loadedFor, pending, failed, ids } satisfies Stored)
}

export function syncState(): SyncState {
  ensureLoaded()
  return { online: isReachable(), pending: [...pending], failed: [...failed], ids: knownIds() }
}

function broadcast(): void {
  const state = syncState()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('sync', state)
  }
  for (const listener of [...listeners]) listener(state)
}

const listeners = new Set<(state: SyncState) => void>()
/** Watch from inside main (and from `verify.ts`). Returns an unsubscribe function. */
export function onSync(listener: (state: SyncState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Not heard, as opposed to refused: no connection at all, or a gateway saying the
 * server behind it is not there right now (a redeploy). Waiting fixes both.
 */
const unheard = (error: unknown): boolean =>
  error instanceof CloudError && (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Hand over one write. Resolves when it has been sent, or as soon as it has to wait. */
export function submit(write: Omit<QueuedWrite, 'at' | 'error'>): Promise<SubmitResult> {
  ensureLoaded()
  if (!isSyncable(write.channel)) return Promise.reject(new Error(`${write.channel} cannot be sent later.`))
  if (!loadedFor) return Promise.reject(new Error('Nobody is signed in.'))
  const entry: QueuedWrite = { ...write, at: new Date().toISOString() }
  pending.push(entry)
  persist()
  const answer = new Promise<SubmitResult>((resolve, reject) => waiters.set(entry.id, { resolve, reject }))
  // Already known to be unreachable: say so now rather than after a request that is
  // bound to fail, and let the retry timer do the asking.
  if (!isReachable() && timer) {
    hold()
  } else {
    void drain()
  }
  broadcast()
  return answer
}

/** Everyone waiting hears that their write is kept rather than sent. */
function hold(): void {
  for (const entry of pending) {
    const waiter = waiters.get(entry.id)
    if (!waiter) continue
    waiters.delete(entry.id)
    waiter.resolve({ state: 'queued' })
  }
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void drain()
  }, backoff)
  timer.unref?.()
  backoff = Math.min(backoff * 2, RETRY_CEILING_MS)
}

/** Send what is waiting, oldest first, until it is all gone or Neo Cloud stops answering. */
export async function drain(): Promise<void> {
  ensureLoaded()
  if (draining) return
  draining = true
  try {
    while (pending.length > 0 && loadSession()) {
      const head = pending[0]!
      const { value: input, unresolved } = resolveIds(head.input)
      if (unresolved.length > 0) {
        // Something it names was never saved — a create that was refused or thrown away.
        const cause = [...failed].reverse().find((f) => f.tempId && unresolved.includes(f.tempId))
        refuse(head, new Error(cause ? `It depends on “${cause.label}”, which was not saved.` : 'It depends on something that was not saved.'))
        continue
      }
      try {
        const output = (await invokeChannel(head.channel as Channel, input as never)) as unknown
        if (pending[0]?.id !== head.id) continue
        pending.shift()
        const id = (output as { id?: unknown } | null)?.id
        if (head.tempId && typeof id === 'string') rememberId(head.tempId, id)
        persist()
        backoff = RETRY_MS
        const waiter = waiters.get(head.id)
        if (waiter) {
          waiters.delete(head.id)
          waiter.resolve({ state: 'sent', output })
        } else {
          replayed = true
        }
        broadcast()
      } catch (error) {
        if (pending[0]?.id !== head.id) continue
        if (unheard(error)) {
          hold()
          broadcast()
          schedule()
          return
        }
        refuse(head, error)
      }
    }
    if (pending.length === 0 && replayed) {
      replayed = false
      // What the window drew while offline was its own guess; now it can have the real thing.
      announceChange()
    }
  } finally {
    draining = false
  }
}

function refuse(entry: QueuedWrite, error: unknown): void {
  pending = pending.filter((p) => p.id !== entry.id)
  const waiter = waiters.get(entry.id)
  if (waiter) {
    waiters.delete(entry.id)
    waiter.reject(error)
  } else {
    failed.push({ ...entry, error: message(error) })
  }
  persist()
  broadcast()
}

/** Send refused writes again, at the back of the line. */
export function retry(id?: string): SyncState {
  ensureLoaded()
  const again = failed.filter((f) => !id || f.id === id)
  failed = failed.filter((f) => !again.includes(f))
  pending.push(...again.map(({ error: _error, ...rest }) => rest))
  persist()
  backoff = RETRY_MS
  void drain()
  broadcast()
  return syncState()
}

/** Give up on refused writes. The window refetches, so what it drew for them goes. */
export function discard(id?: string): SyncState {
  ensureLoaded()
  failed = failed.filter((f) => id && f.id !== id)
  persist()
  broadcast()
  announceChange()
  return syncState()
}

/**
 * Everything waiting, for every account, gone — on signing out, or being signed out.
 * Nothing is sent: the person asked for this machine to stop acting as them.
 */
export function forgetOutbox(except?: string): void {
  for (const [, waiter] of waiters) waiter.reject(new Error('Signed out.'))
  waiters.clear()
  if (!except || loadedFor !== except) {
    pending = []
    failed = []
    forgetIds()
    loadedFor = null
  }
  for (const name of listSealed(PREFIX)) {
    if (except && name === fileFor(except)) continue
    removeSealed(name)
  }
  if (timer) clearTimeout(timer)
  timer = null
  broadcast()
}

/** Start sending whatever was left waiting the last time, and keep listening for the way back. */
export function startOutbox(): void {
  ensureLoaded()
  void drain()
}

onReachability((reachable) => {
  if (reachable) {
    if (timer) clearTimeout(timer)
    timer = null
    backoff = RETRY_MS
    void drain()
  }
  broadcast()
})
