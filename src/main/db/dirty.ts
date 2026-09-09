import { randomUUID } from 'node:crypto'
import type { RowChange, SyncedTable } from '@shared/tables'
import { TABLES, syncableFields } from '@shared/tables'
import { q, q1, exec } from './client'
import { workspaceOf } from './apply'

/**
 * What this machine is, what it has changed, and what is still waiting to go.
 *
 * Nothing here talks to a network. The sync engine reads `waiting()` and calls
 * `settle()`; with no engine attached the marks simply accumulate, which is what
 * makes Local and Neo Sync the same code path rather than two — and what makes
 * signing in on a Mac with three years of work in it an ordinary first push rather
 * than a migration of its own.
 */

/* ------------------------------------------------------------------ *
 * This machine
 * ------------------------------------------------------------------ */

let device = ''

export function deviceId(): string {
  if (!device) throw new Error('The sync queue was used before initSync()')
  return device
}

/**
 * The device id lives in `setting`, which is to say inside the data folder — so
 * deleting `~/.neo` loses it and the machine comes back as a *new* device rather than
 * the same one resuming. That is the correct behaviour and not an accident: a device
 * that resumed with a cursor from a database that no longer exists would ask for
 * everything after some revision and correctly receive nothing.
 */
export async function initSync(): Promise<void> {
  const existing = await q1<{ value: string }>(
    `SELECT value FROM setting WHERE key = 'deviceId'`
  )
  device = existing?.value ?? randomUUID()
  if (!existing) {
    await exec(
      `INSERT INTO setting (key, value) VALUES ('deviceId', $1) ON CONFLICT (key) DO NOTHING`,
      [device]
    )
  }
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

export interface Waiting extends RowChange {
  workspaceId: string
}

/** How many rows are waiting to be handed over. For the status line. */
export async function pendingCount(): Promise<number> {
  const row = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM sync_dirty`)
  return row?.n ?? 0
}

/**
 * What this device has changed and not yet handed over, for one workspace.
 *
 * In dependency order, parents before children. Not because the server would refuse
 * a child that arrives first — it has no foreign keys and deliberately accepts
 * whatever it is given — but because the revision numbers it hands out are the order
 * *every other device* receives them in, and a device that is told about a task
 * before the project it sits in has to defer it and try again.
 */
export async function waiting(workspaceId: string, limit = 500): Promise<Waiting[]> {
  const rows = await q<{
    table_name: string; row_id: string; changed_at: Date; deleted: boolean
  }>(
    `SELECT table_name, row_id, changed_at, deleted
       FROM sync_dirty
      WHERE workspace_id = $1
      ORDER BY array_position($2::text[], table_name), changed_at
      LIMIT $3`,
    [workspaceId, SYNC_ORDER, limit]
  )

  const out: Waiting[] = []
  for (const row of rows) {
    const change = await changeFor(
      row.table_name as SyncedTable, row.row_id, new Date(row.changed_at), row.deleted
    )
    /*
     * A row that is marked as changed and is not there is one that was deleted by a
     * cascade without its own delete being recorded — or a bug. Either way there is
     * nothing to send, so the mark goes rather than being retried for ever.
     */
    if (!change) {
      await exec(`DELETE FROM sync_dirty WHERE table_name = $1 AND row_id = $2`,
        [row.table_name, row.row_id])
      continue
    }
    out.push({ ...change, workspaceId })
  }
  return out
}

/** Every workspace that has something waiting, including ones already deleted here. */
export async function workspacesWaiting(): Promise<string[]> {
  const rows = await q<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM sync_dirty WHERE workspace_id IS NOT NULL`
  )
  return rows.map((r) => r.workspace_id)
}

/**
 * The rows have been handed over, so they are no longer waiting.
 *
 * Guarded on `changed_at`: a row edited again while the push was in flight is still
 * waiting, and clearing it blindly would lose that edit until something else touched
 * the row. This is the whole reason the mark carries a time rather than being a flag.
 */
export async function settle(changes: RowChange[]): Promise<void> {
  for (const change of changes) {
    await exec(
      `DELETE FROM sync_dirty
        WHERE table_name = $1 AND row_id = $2 AND changed_at <= $3`,
      [change.table, change.id, new Date(change.changedAt)]
    )
  }
}

/**
 * One row, as it goes on the wire.
 *
 * Device-only columns come off here rather than at the call site, so there is one
 * answer to "what leaves this machine" and it is the declaration in
 * `shared/tables.ts`.
 */
export async function changeFor(
  table: SyncedTable,
  rowId: string,
  changedAt: Date,
  deleted: boolean
): Promise<RowChange | null> {
  if (deleted) {
    return { table, id: rowId, deleted: true, changedAt: changedAt.toISOString(), fields: {} }
  }
  const row = await q1<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = $1`, [rowId])
  if (!row) return null
  return {
    table,
    id: rowId,
    deleted: false,
    changedAt: changedAt.toISOString(),
    fields: syncableFields(table, row)
  }
}

/* ------------------------------------------------------------------ *
 * Adoption
 * ------------------------------------------------------------------ */

/**
 * Mark everything already in the database as something to hand over.
 *
 * Every install that existed before this has years of work in it and nothing saying
 * so. Without this the first sync would offer another device nothing — which is the
 * worst possible way for the feature to arrive — and an install upgrading from the
 * operation log would offer it nothing either, because the log it used to keep is
 * gone.
 *
 * It is also what makes the sample data work: `sample.ts` writes its rows with plain
 * SQL, deliberately, because it is a fixture rather than something somebody did, and
 * this picks them up afterwards without it needing to know about syncing at all.
 *
 * The times are the rows' own, not now: a project made in March should say March, so
 * that a device which has genuinely edited it since wins on the clock. Tables without
 * a `created_at` fall back to the epoch, which is older than any real edit.
 */
export async function adoptExistingRows(): Promise<{ rows: number }> {
  let adopted = 0

  for (const table of SYNC_ORDER) {
    const columns = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'created_at'`,
      [table]
    )
    const when = columns.length > 0 ? 'COALESCE(t.created_at, to_timestamp(0))' : 'to_timestamp(0)'

    for (;;) {
      const rows = await q<{ id: string; at: Date }>(
        `SELECT t.id, ${when} AS at FROM ${table} t
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_dirty d WHERE d.table_name = $1 AND d.row_id = t.id::text
          )
          LIMIT 500`,
        [table]
      )
      if (rows.length === 0) break

      for (const row of rows) {
        const workspaceId = (await workspaceOf(table, row.id).catch(() => null))
          ?? (table === 'workspace' ? row.id : null)
        await exec(
          `INSERT INTO sync_dirty (table_name, row_id, workspace_id, changed_at, deleted)
                VALUES ($1, $2, $3, $4, false)
           ON CONFLICT (table_name, row_id) DO NOTHING`,
          [table, row.id, workspaceId, row.at]
        )
      }
      adopted += rows.length
      if (rows.length < 500) break
    }
  }
  return { rows: adopted }
}

/* ------------------------------------------------------------------ *
 * Tombstones
 * ------------------------------------------------------------------ */

/**
 * How long a delete has to be remembered.
 *
 * A tombstone is what stops a device that has been offline from resurrecting
 * something deleted while it was away, so the window has to be longer than any
 * plausible absence. A quarter is generous and the table is three columns wide.
 */
const TOMBSTONE_DAYS = 90

export async function sweepTombstones(): Promise<number> {
  const rows = await q<{ row_id: string }>(
    `DELETE FROM sync_tombstone
      WHERE deleted_at < now() - make_interval(days => $1)
        AND NOT EXISTS (
          SELECT 1 FROM sync_dirty d
           WHERE d.table_name = sync_tombstone.table_name AND d.row_id = sync_tombstone.row_id
        )
      RETURNING row_id`,
    [TOMBSTONE_DAYS]
  )
  return rows.length
}

/* ------------------------------------------------------------------ *
 * Order
 * ------------------------------------------------------------------ */

/**
 * Parents before children. Derived from the owner chain and from explicit cross-table
 * references, so a new table joins the order by declaring what it hangs off rather
 * than by somebody remembering to add it here in the right place.
 */
export const SYNC_ORDER: SyncedTable[] = (() => {
  const names = Object.keys(TABLES) as SyncedTable[]
  const depth = (t: SyncedTable, guard = 0): number => {
    if (guard > 8) return 0
    const owner = TABLES[t].owner
    const ownerDepth = !owner ? 0 : depth(owner.table, guard + 1) + 1
    const refs = TABLES[t].references ?? []
    const refDepth = refs.length > 0 ? Math.max(...refs.map((r) => depth(r, guard + 1))) + 1 : 0
    return Math.max(ownerDepth, refDepth)
  }
  return names.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
})()
