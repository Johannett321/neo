import { useSyncExternalStore } from 'react'
import type { Query, QueryClient } from '@tanstack/react-query'
import type { Channel } from '@shared/api'
import { EMPTY_SYNC, swapIds, type SyncState } from '@shared/sync'
import { contextFor, Draft, optimistFor } from './optimistic'

/**
 * The window's half of working without Neo Cloud.
 *
 * Main keeps the line of writes waiting to be sent (`lib/cloud/outbox.ts`) and says
 * whenever it moves; this keeps the latest word of it for the screens that show it
 * (the indicator in the header, `Pending`, the buttons that cannot work offline), and
 * does the two things only the window can:
 *
 * **Lays waiting writes back over fresh answers.** A refetch while a write is still in
 * the line — the window regaining focus, a change from another device — answers with
 * what Neo Cloud has, which does not have the write yet. Every waiting write is applied
 * again on top of each answer as it lands, so nothing drawn ahead of the server blinks
 * out and back in. Optimists are idempotent precisely so this is safe.
 *
 * **Keeps a new thing's key steady.** A row drawn under `tmp-…` is the same row once it
 * has a real id, and `stableKey` says so to React, so it is updated rather than
 * unmounted and mounted again — no flicker, no lost hover, no replayed entrance.
 */

let state: SyncState = EMPTY_SYNC
const subscribers = new Set<() => void>()

/** Writes this window has made and not yet heard back about, by write id. */
const inflight = new Map<string, Op>()
/** Writes already laid over the whole cache once, so a new word from main does not do it twice. */
const applied = new Set<string>()
/** Real id → the temporary one it was first drawn under. */
const keys = new Map<string, string>()
/** Temporary id → real id, from main and from this window's own creates. */
const ids = new Map<string, string>()

interface Op {
  id: string
  channel: Channel
  input: unknown
  tempId?: string
}

const emit = (): void => {
  for (const fn of [...subscribers]) fn()
}

export const getSync = (): SyncState => state

export function useSync(): SyncState {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    () => state
  )
}

/** Whether Neo Cloud is answering. Offline-only buttons read this and say why they are off. */
export const useOnline = (): boolean => useSync().online

/** The key to render a row under: the temporary id it first appeared with, if it had one. */
export const stableKey = (id: string): string => keys.get(id) ?? id

export function rememberId(temp: string, real: string): void {
  ids.set(temp, real)
  keys.set(real, temp)
}

export function startOp(op: Op): void {
  inflight.set(op.id, op)
  applied.add(op.id)
}

export function finishOp(id: string): void {
  inflight.delete(id)
}

/** Waiting writes, oldest first, with any temporary id that has since been given a real one swapped. */
function waiting(): Op[] {
  const seen = new Set<string>()
  const out: Op[] = []
  for (const op of [...state.pending, ...inflight.values()]) {
    if (seen.has(op.id)) continue
    seen.add(op.id)
    out.push({ ...op, input: swapIds(op.input, (id) => ids.get(id)).value })
  }
  return out
}

/** Apply waiting writes to one answer, or to the whole cache. */
function lay(client: QueryClient, ops: Op[], scope?: Query): void {
  if (ops.length === 0) return
  const draft = new Draft(client, scope)
  for (const op of ops) {
    try {
      optimistFor(op.channel)?.apply(op.input as never, draft, contextFor(op.tempId))
    } catch {
      // A guess that cannot be drawn is a guess not drawn; the write itself still goes.
    }
  }
}

/** Every waiting write, over the whole cache — after a refused write has been taken back out. */
export const relay = (client: QueryClient): void => lay(client, waiting())

/**
 * Swap a temporary id for the real one in everything cached, the moment the create
 * comes back, so the next write naming it and the refetch that follows agree.
 */
export function reconcile(client: QueryClient, temp: string, real: string | undefined): void {
  if (!real) return
  rememberId(temp, real)
  for (const query of client.getQueryCache().getAll()) {
    const data = query.state.data
    if (data === undefined || !JSON.stringify(data).includes(temp)) continue
    client.setQueryData(query.queryKey, swapIds(data, (id) => (id === temp ? real : undefined)).value)
  }
}

const everythingButTheAccount = {
  predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'account:status'
}

/**
 * Listen to main, and to the cache. Called once, before the first render, with the
 * client every screen uses. Returns a function that stops both.
 */
export function startSync(client: QueryClient): () => void {
  const accept = (next: SyncState): void => {
    const was = state
    state = next
    for (const [temp, real] of Object.entries(next.ids)) rememberId(temp, real)

    // Writes this window has not drawn yet — left waiting by the last session, or put
    // back in line by Retry — are drawn now.
    const fresh = waiting().filter((op) => !applied.has(op.id))
    for (const op of fresh) applied.add(op.id)
    lay(client, fresh)

    // Neo Cloud is back: who is signed in may have changed while it was away, and
    // everything on screen is a copy from before. With writes still in line the
    // refetch waits for them — main says when they have all gone (`announceChange`) —
    // because an answer from halfway through would briefly lack the ones just sent.
    if (!was.online && next.online) {
      void client.invalidateQueries({ queryKey: ['account:status'] })
      if (next.pending.length === 0) void client.invalidateQueries(everythingButTheAccount)
    }
    // A write sent from the line and refused has nobody waiting to take its guess back
    // out; refetching does, and the failure is listed until it is retried or discarded.
    if (next.failed.length > was.failed.length && next.online) {
      void client.invalidateQueries(everythingButTheAccount)
    }
    emit()
  }

  const stopMain = window.api.onSync(accept)
  void window.api.invoke('sync:state').then(accept).catch(() => {})

  const stopCache = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return
    lay(client, waiting(), event.query)
  })

  return () => {
    stopMain()
    stopCache()
  }
}
