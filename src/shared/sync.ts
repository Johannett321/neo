/**
 * Writes that are kept until Neo Cloud takes them.
 *
 * The common writes — a task, a person, a decision, a log entry, a link, a note — are
 * shown on screen the moment they are made and then handed to the main process, which
 * sends them in the order they were made. When Neo Cloud cannot be reached they wait
 * in that order, sealed on disk beside the session, and go as soon as it can be.
 *
 * Something created before Neo Cloud has seen it has no id of its own yet, so it is
 * given a temporary one (`tmp-…`). Every later write that names it — an edit, a move,
 * a membership pointing at a new person — carries the temporary id, and the main
 * process swaps in the real one when the create comes back. A temporary id never
 * reaches Neo Cloud.
 */

import type { Channel } from './api'

export const TEMP_PREFIX = 'tmp-'

export const isTempId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(TEMP_PREFIX)

export const tempId = (): string => `${TEMP_PREFIX}${crypto.randomUUID()}`

/**
 * The channels that may be kept and sent later. Only writes whose effect the window
 * can draw before Neo Cloud answers, and whose answer nothing else waits on: no
 * uploads (the bytes are not kept), nothing the assistant does, nothing a recording
 * does (audio has its own queue), and no account business.
 */
export const SYNCABLE = [
  'task:save', 'task:setStatus', 'task:setColumn', 'task:delete',
  'person:save', 'membership:save',
  'decision:save', 'decision:delete',
  'journal:save', 'journal:delete',
  'link:save', 'link:delete',
  'note:save', 'note:delete'
] as const satisfies readonly Channel[]

export type SyncableChannel = (typeof SYNCABLE)[number]

export const isSyncable = (channel: string): channel is SyncableChannel =>
  (SYNCABLE as readonly string[]).includes(channel)

/** One write, as it waits. */
export interface QueuedWrite {
  /** Chosen by the window, so both sides can talk about the same write. */
  id: string
  channel: SyncableChannel
  input: unknown
  /** Set on a create: the id the window drew the new thing under. */
  tempId?: string
  /** What it was, in words — "Add task “Draft the brief”". */
  label: string
  /** ISO time it was made. */
  at: string
  /** Why it was refused, once it has been. */
  error?: string
}

export interface SyncState {
  /** Whether Neo Cloud answered the last time anything asked it. */
  online: boolean
  /** Waiting to be sent, oldest first. */
  pending: QueuedWrite[]
  /** Refused by Neo Cloud; kept until retried or discarded. */
  failed: QueuedWrite[]
  /** Temporary ids that have since been given real ones. */
  ids: Record<string, string>
}

export const EMPTY_SYNC: SyncState = { online: true, pending: [], failed: [], ids: {} }

export type SubmitResult = { state: 'sent'; output: unknown } | { state: 'queued' }

/**
 * Walk a value and swap every temporary id for the real one. Returns the ids that had
 * nothing to swap in, which is how a write that depends on something never saved is
 * caught before it is sent.
 */
export function swapIds<T>(value: T, real: (id: string) => string | undefined): { value: T; unresolved: string[] } {
  const unresolved: string[] = []
  const walk = (v: unknown): unknown => {
    if (isTempId(v)) {
      const found = real(v)
      if (!found) unresolved.push(v)
      return found ?? v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(v)) out[key] = walk(inner)
      return out
    }
    return v
  }
  return { value: walk(value) as T, unresolved }
}

export const hasTempIds = (value: unknown): boolean => swapIds(value, () => undefined).unresolved.length > 0
