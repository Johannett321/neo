import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Batch, Op, SyncedTable } from '@shared/ops'
import { SCHEMA_VERSION, TABLES } from '@shared/ops'
import { q, q1, exec } from './client'
import { applyRun, stampExisting } from './apply'
import { upcast } from './upcast'
import type { LocalWrite } from './apply'
import * as hlc from './hlc'

/**
 * The log itself: who this machine is, what it has written, and how something
 * written elsewhere gets in.
 *
 * Nothing here talks to a network. A transport is attached in Stage 1 and reads
 * `pending()` / calls `ingest()`; with no transport attached the log is simply a
 * record, which is what makes Local and Neo Sync the same code path rather than two.
 */

/* ------------------------------------------------------------------ *
 * This machine
 * ------------------------------------------------------------------ */

let device = ''

export function deviceId(): string {
  if (!device) throw new Error('Oplog used before initOplog()')
  return device
}

/**
 * The device id lives in `setting`, which is to say inside the data folder — so
 * deleting `~/.neo` loses it and the machine comes back as a *new* device rather
 * than the same one resuming. That is the correct behaviour and not an accident: a
 * device that resumed with a cursor from a database that no longer exists would ask
 * for everything after some sequence number and correctly receive nothing.
 */
export async function initOplog(): Promise<void> {
  const existing = await q1<{ value: string }>(
    `SELECT value FROM setting WHERE key = 'deviceId'`
  )
  device = existing?.value ?? randomUUID()
  if (!existing) {
    await exec(
      `INSERT INTO setting (key, value) VALUES ('deviceId', $1)
       ON CONFLICT (key) DO NOTHING`,
      [device]
    )
  }
  hlc.setDevice(device)

  // Seeded from what is already on disk so a restart — or a clock that has been put
  // back — never reissues a stamp that has already been handed out.
  const highest = await q1<{ hlc: string }>(`SELECT hlc FROM op_batch ORDER BY hlc DESC LIMIT 1`)
  hlc.seed(highest?.hlc ?? null)
}

/* ------------------------------------------------------------------ *
 * One user action, one batch
 * ------------------------------------------------------------------ */

interface Pending {
  ops: { op: Op; workspaceId: string | null }[]
}

const ambient = new AsyncLocalStorage<Pending>()

/**
 * Collect every write made inside `fn` into one batch.
 *
 * `handle()` wraps each channel in this, so saving a task is one batch containing
 * the task and the activity row that describes it. That grouping is what turns
 * "every mutation logs activity" from a convention each handler has to remember into
 * something structural — and it gives an atomic unit to send, to apply, and one day
 * to undo.
 */
export async function withBatch<T>(fn: () => Promise<T>): Promise<T> {
  if (ambient.getStore()) return fn()
  const pending: Pending = { ops: [] }
  const result = await ambient.run(pending, fn)
  await commit(pending)
  return result
}

/** Called by every local write. Joins the ambient batch, or becomes one on its own. */
export async function collect(write: LocalWrite): Promise<void> {
  if (!write.op) return
  const store = ambient.getStore()
  if (store) {
    store.ops.push({ op: write.op, workspaceId: write.workspaceId })
    return
  }
  await commit({ ops: [{ op: write.op, workspaceId: write.workspaceId }] })
}

/**
 * Ops are grouped by workspace on the way out, one batch each.
 *
 * A batch is what gets encrypted under a workspace key and appended to that
 * workspace's stream, so a batch that spanned two of them could not be sent at all.
 * In practice nothing writes across the boundary — that is the point of the
 * boundary — and grouping here means the invariant is enforced rather than trusted.
 */
async function commit(pending: Pending): Promise<void> {
  if (pending.ops.length === 0) return
  /*
   * Loud rather than silent. Writing before `initOplog()` would produce batches from
   * a device with no identity and stamps from a clock with no tiebreak — a log that
   * looks fine and orders wrongly the moment a second machine appears. The startup
   * order in `index.ts` puts this first for that reason; anything else that opens the
   * database has to do the same.
   */
  if (!device) throw new Error('A write reached the log before initOplog()')

  const byWorkspace = new Map<string, Op[]>()
  for (const entry of pending.ops) {
    const key = entry.workspaceId ?? ''
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), entry.op])
  }

  for (const [workspaceId, ops] of byWorkspace) {
    await exec(
      `INSERT INTO op_batch (id, workspace_id, device_id, actor_id, schema_version, hlc, origin, ops)
       VALUES ($1, $2, $3, NULL, $4, $5, 'local', $6::jsonb)`,
      [
        randomUUID(),
        workspaceId || null,
        device,
        SCHEMA_VERSION,
        ops[ops.length - 1].hlc,
        JSON.stringify(ops)
      ]
    )
  }
}

/* ------------------------------------------------------------------ *
 * Reading and receiving
 * ------------------------------------------------------------------ */

export interface StoredBatch extends Batch {
  seq: string
  origin: 'local' | 'remote'
}

/** How many batches are waiting to be handed over. For the status line. */
export async function pendingCount(afterSeq = '0'): Promise<number> {
  const row = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM op_batch WHERE origin = 'local' AND seq > $1`,
    [afterSeq]
  )
  return row?.n ?? 0
}

/** What this device has written and not yet handed to a transport. */
export async function pending(afterSeq = '0', limit = 200): Promise<StoredBatch[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT seq, id, workspace_id, device_id, actor_id, schema_version, hlc, origin, ops
       FROM op_batch
      WHERE origin = 'local' AND seq > $1
      ORDER BY seq ASC
      LIMIT $2`,
    [afterSeq, limit]
  )
  return rows.map(toBatch)
}

/** Everything, oldest first, for replay. */
export async function allBatches(): Promise<StoredBatch[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT seq, id, workspace_id, device_id, actor_id, schema_version, hlc, origin, ops
       FROM op_batch ORDER BY hlc ASC, seq ASC`
  )
  return rows.map(toBatch)
}

function toBatch(row: Record<string, unknown>): StoredBatch {
  return {
    seq: String(row.seq),
    id: row.id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    deviceId: row.device_id as string,
    actorId: (row.actor_id as string | null) ?? null,
    schema: Number(row.schema_version),
    hlc: row.hlc as string,
    origin: row.origin as 'local' | 'remote',
    ops: (typeof row.ops === 'string' ? JSON.parse(row.ops) : row.ops) as Op[]
  }
}

/**
 * Take in a batch that was made somewhere else.
 *
 * Recorded whether or not any of its ops win, because the record is what lets this
 * device hand the batch on to a third one, and what makes "have I seen this?"
 * answerable without asking the server.
 */
export async function ingest(batch: Batch): Promise<{ applied: number }> {
  const seen = await q1<{ id: string }>(`SELECT id FROM op_batch WHERE id = $1`, [batch.id])
  if (seen) return { applied: 0 }

  const ops: Op[] = []
  for (const raw of batch.ops) {
    const op = upcast(raw, batch.schema)
    if (op) ops.push(op)
  }
  const { applied } = await applyRun(ops)

  await exec(
    `INSERT INTO op_batch (id, workspace_id, device_id, actor_id, schema_version, hlc, origin, ops)
     VALUES ($1, $2, $3, $4, $5, $6, 'remote', $7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      batch.id,
      batch.workspaceId,
      batch.deviceId,
      batch.actorId,
      batch.schema,
      batch.hlc,
      JSON.stringify(batch.ops)
    ]
  )
  return { applied }
}

/* ------------------------------------------------------------------ *
 * Adoption
 * ------------------------------------------------------------------ */

/**
 * Take everything already in the database into the log.
 *
 * Every install that existed before Stage 0 has years of work in it and not one
 * operation describing any of it. Without this, replay would produce an empty
 * database and the first sync would offer another device nothing — which is the
 * worst possible way for this feature to arrive.
 *
 * So on the first launch after the upgrade, every row that has no `sync_row` entry
 * gets one, and a genesis batch is written describing it. It is also what makes the
 * sample data work: `sample.ts` writes its rows with plain SQL, deliberately, because
 * it is a fixture rather than something somebody did, and this picks them up
 * afterwards without it needing to know about the log at all.
 *
 * The stamps are the *lowest* the clock can issue rather than the current one. What
 * is here already is the oldest thing there is: any real edit, on any device, must
 * win against it.
 */
export async function adoptExistingRows(): Promise<{ rows: number }> {
  let adopted = 0

  for (const table of SYNC_ORDER) {
    for (;;) {
      const rows = await q<Record<string, unknown>>(
        `SELECT t.* FROM ${table} t
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_row s WHERE s.table_name = $1 AND s.row_id = t.id::text
          )
          LIMIT 500`,
        [table]
      )
      if (rows.length === 0) break

      const ops: { op: Op; workspaceId: string | null }[] = []
      for (const row of rows) {
        const write = await stampExisting(table, String(row.id), GENESIS)
        if (write.op) ops.push({ op: write.op, workspaceId: write.workspaceId })
      }
      await commit({ ops })
      adopted += rows.length
      if (rows.length < 500) break
    }
  }
  return { rows: adopted }
}

/** Older than anything the clock will ever issue. */
const GENESIS = '000000000000000.00000.genesis'

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

/**
 * Throw the database away and rebuild it from the log.
 *
 * This is the correctness argument for the whole design, and it is a test rather
 * than a feature: if replaying what was written reproduces exactly what is here,
 * then the log is a complete account of the work and everything downstream — another
 * device, a restore, a new phone — follows. `verify.ts` asserts it.
 */
export async function replayLog(): Promise<{ batches: number; ops: number; dropped: number }> {
  const batches = await allBatches()

  // Children first, so nothing is removed out from under a foreign key.
  for (const table of [...SYNC_ORDER].reverse()) await exec(`DELETE FROM ${table}`)
  await exec(`DELETE FROM sync_row`)

  const ops: Op[] = []
  for (const batch of batches) {
    for (const raw of batch.ops) {
      const op = upcast(raw, batch.schema)
      if (op) ops.push(op)
    }
  }
  const { applied, dropped } = await applyRun(ops)
  return { batches: batches.length, ops: applied, dropped }
}

/**
 * Parents before children. Derived from the owner chain rather than written out, so
 * a new table joins the order by declaring where it hangs rather than by someone
 * remembering to add it here in the right place.
 */
export const SYNC_ORDER: SyncedTable[] = (() => {
  const names = Object.keys(TABLES) as SyncedTable[]
  const depth = (t: SyncedTable, guard = 0): number => {
    const owner = TABLES[t].owner
    return !owner || guard > 8 ? 0 : depth(owner.table, guard + 1) + 1
  }
  return names.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
})()
