import type { Op } from '@shared/ops'
import { SCHEMA_VERSION } from '@shared/ops'

/**
 * Bringing an op written against an older schema up to the current one.
 *
 * The log is immutable. An op is a historical fact — it says what somebody did, in
 * the vocabulary the app had at the time — and it is never rewritten in place. That
 * is not merely a preference: the sync server holds ciphertext and *cannot* rewrite
 * an op, so end-to-end encryption removes the tempting wrong answer entirely.
 *
 * Instead the schema version travels with the batch and an incoming op is walked up
 * to the present on the way in, one small function per version. This is event
 * upcasting, and the cost of each kind of change is worth knowing before making one:
 *
 *   - Adding a column costs nothing. An op that never mentions it leaves it at its
 *     default, which is the large majority of real changes.
 *   - A rename or a drop costs one entry here.
 *   - Splitting or merging a table cannot be expressed per-op at all: it needs a log
 *     epoch — every device writes a fresh snapshot at the new version and the old
 *     history is retired to the retention window.
 *
 * A rename runs in both directions in practice. The Mac you have not updated yet
 * keeps emitting the old column name, and the entry below handles those too, because
 * the version comes with the op rather than being assumed from the receiver.
 *
 * **These functions are near-permanent.** Point-in-time restore replays old ops, so
 * one can only be retired once no reachable snapshot predates it. Keep them for a
 * year; then refuse older logs with a clear message rather than deleting the code
 * and silently misreading them. They are not dead code, whatever their coverage
 * looks like.
 */
type Upcaster = (op: Op) => Op | null

/** Keyed by the version the op was written at; applied in ascending order. */
const UPCAST: Record<number, Upcaster> = {
  // Empty, and deliberately shipped empty. The chain costs nothing while there is
  // nothing in it, and adding it later would mean every op already written is
  // unversioned and has to be guessed at.
}

export class SchemaTooNew extends Error {
  constructor(readonly saw: number) {
    super(`This batch was written by a newer version of Neo (schema ${saw}, this one understands ${SCHEMA_VERSION}).`)
    this.name = 'SchemaTooNew'
  }
}

/**
 * Returns null for an op that no longer means anything — a write to a column that
 * has since been dropped, say. Dropping it is correct: the column is gone, so there
 * is nothing the op could do.
 */
export function upcast(op: Op, from: number): Op | null {
  if (from > SCHEMA_VERSION) throw new SchemaTooNew(from)
  let current: Op | null = op
  for (let v = from; v < SCHEMA_VERSION && current; v += 1) {
    const step = UPCAST[v]
    if (step) current = step(current)
  }
  return current
}

/** Helpers for writing the entries above. */
export const rename = (op: Op, from: string, to: string): Op => {
  if (!op.fields || !(from in op.fields)) return op
  const { [from]: value, ...rest } = op.fields
  return { ...op, fields: { ...rest, [to]: value } }
}

export const drop = (op: Op, field: string): Op => {
  if (!op.fields || !(field in op.fields)) return op
  const { [field]: _gone, ...rest } = op.fields
  return { ...op, fields: rest }
}
