import { randomUUID } from 'node:crypto'
import type { Op, SyncedTable } from '@shared/ops'
import { TABLES, isSynced, syncableFields } from '@shared/ops'
import { q, q1, exec } from './client'
import * as hlc from './hlc'

/**
 * The only thing in the application that writes a domain table.
 *
 * A click, an assistant tool call, a task created from Claude Desktop and a batch
 * arriving from another device all end up here, which is what makes them the same
 * write rather than four that resemble each other. Everything above this decides
 * *what* to write; this decides whether it wins and puts it down.
 */

/* ------------------------------------------------------------------ *
 * What the database actually looks like
 * ------------------------------------------------------------------ */

const columnCache = new Map<string, Set<string>>()

/**
 * Asked of the database rather than kept as a list beside the schema, for the same
 * reason `writeCount()` asks whether a statement wrote instead of consulting a list
 * of "the channels that write": a second description of the truth drifts from it.
 *
 * It also gives forward compatibility for nothing: an op from a newer version of Neo
 * mentioning a column this one has never heard of has that field dropped here rather
 * than failing the whole batch.
 */
export async function columnsOf(table: string): Promise<Set<string>> {
  const hit = columnCache.get(table)
  if (hit) return hit
  const rows = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  )
  const set = new Set(rows.map((r) => r.column_name))
  columnCache.set(table, set)
  return set
}

export const forgetColumns = (): void => columnCache.clear()

/**
 * The real ON DELETE CASCADE graph, read out of `pg_constraint`.
 *
 * A hand-written copy of this would be a second description of the foreign keys and
 * would drift the first time somebody added one — and the consequence of it drifting
 * is a row that comes back from the dead on another machine, which is about the worst
 * failure this design can have. `meeting_attendee` cascades from `person` as well as
 * from `meeting`, and `transcript_cue` from `recording_segment` as well as
 * `recording`; a chain walked from the owner metadata alone would miss both.
 */
let cascades: Map<string, { child: string; column: string }[]> | null = null

async function cascadeGraph(): Promise<Map<string, { child: string; column: string }[]>> {
  if (cascades) return cascades
  const rows = await q<{ child: string; col: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child,
            a.attname                  AS col,
            c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confdeltype = 'c'`
  )
  const map = new Map<string, { child: string; column: string }[]>()
  for (const r of rows) {
    const list = map.get(r.parent) ?? []
    list.push({ child: r.child, column: r.col })
    map.set(r.parent, list)
  }
  cascades = map
  return map
}

export const forgetCascades = (): void => {
  cascades = null
}

/* ------------------------------------------------------------------ *
 * Where a row lives
 * ------------------------------------------------------------------ */

/**
 * Walk a row up to the workspace it belongs to.
 *
 * Every synced table reaches one; the workspace is the unit of sync, of encryption
 * and later of sharing, exactly as it is already the unit of isolation on every
 * scoped channel. Resolved *before* a delete, because afterwards there is nothing
 * left to ask.
 */
export async function workspaceOf(table: SyncedTable, rowId: string): Promise<string | null> {
  let current: SyncedTable = table
  let id: string | null = rowId
  // The chain is four deep at its longest (summary_part → recording → meeting →
  // project → workspace); the guard is for a schema change that accidentally makes
  // it circular, which should not cost the app its main process.
  for (let hop = 0; hop < 8 && id; hop += 1) {
    const owner = TABLES[current].owner
    if (!owner) return id
    const row: Record<string, unknown> | null = await q1(
      `SELECT ${owner.column} AS parent FROM ${current} WHERE id = $1`,
      [id]
    )
    if (!row) return null
    id = (row.parent as string | null) ?? null
    current = owner.table
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Sync metadata
 * ------------------------------------------------------------------ */

interface RowState {
  field_hlc: Record<string, string>
  deleted_hlc: string | null
}

async function stateOf(table: string, rowId: string): Promise<RowState | null> {
  return q1<RowState>(
    `SELECT field_hlc, deleted_hlc FROM sync_row WHERE table_name = $1 AND row_id = $2`,
    [table, rowId]
  )
}

async function stamp(table: string, rowId: string, fields: string[], at: string): Promise<void> {
  if (fields.length === 0) return
  const patch = Object.fromEntries(fields.map((f) => [f, at]))
  await exec(
    `INSERT INTO sync_row (table_name, row_id, field_hlc)
          VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (table_name, row_id)
     DO UPDATE SET field_hlc = sync_row.field_hlc || EXCLUDED.field_hlc`,
    [table, rowId, JSON.stringify(patch)]
  )
}

async function tombstone(table: string, rowId: string, at: string): Promise<void> {
  await exec(
    `INSERT INTO sync_row (table_name, row_id, deleted_hlc)
          VALUES ($1, $2, $3)
     ON CONFLICT (table_name, row_id)
     DO UPDATE SET deleted_hlc = EXCLUDED.deleted_hlc, field_hlc = '{}'::jsonb`,
    [table, rowId, at]
  )
}

/** Every row the database will remove along with this one. */
async function descendants(
  table: string,
  rowId: string
): Promise<{ table: string; id: string }[]> {
  const graph = await cascadeGraph()
  const found: { table: string; id: string }[] = []
  const seen = new Set<string>([`${table}:${rowId}`])
  let frontier = [{ table, id: rowId }]

  for (let depth = 0; depth < 12 && frontier.length; depth += 1) {
    const next: { table: string; id: string }[] = []
    for (const node of frontier) {
      for (const edge of graph.get(node.table) ?? []) {
        const rows = await q<{ id: string }>(
          `SELECT id FROM ${edge.child} WHERE ${edge.column} = $1`,
          [node.id]
        )
        for (const r of rows) {
          const key = `${edge.child}:${r.id}`
          if (seen.has(key)) continue
          seen.add(key)
          const hit = { table: edge.child, id: r.id }
          found.push(hit)
          next.push(hit)
        }
      }
    }
    frontier = next
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function writeRow(
  table: string,
  rowId: string,
  fields: Record<string, unknown>,
  exists: boolean
): Promise<Record<string, unknown> | null> {
  const entries = Object.entries(fields)

  if (exists) {
    if (entries.length === 0) return q1(`SELECT * FROM ${table} WHERE id = $1`, [rowId])
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')
    return q1(
      `UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`,
      [rowId, ...entries.map(([, v]) => v)]
    )
  }

  const cols = ['id', ...entries.map(([k]) => k)]
  const values = [rowId, ...entries.map(([, v]) => v)]
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  return q1(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  )
}

/* ------------------------------------------------------------------ *
 * A write made here
 * ------------------------------------------------------------------ */

export interface LocalWrite {
  op: Op | null
  workspaceId: string | null
  row: Record<string, unknown> | null
}

/**
 * Insert or update a row because somebody on this machine asked for it.
 *
 * Local writes always win — their stamp is the newest one this device can issue — so
 * there is no last-write-wins comparison on this path. Device-only columns are
 * written to the row and left out of the op, which is how the recording pipeline
 * keeps its state without two Macs racing to transcribe the same segment.
 */
export async function putLocal(
  table: SyncedTable,
  rowId: string | undefined,
  fields: Record<string, unknown>
): Promise<LocalWrite> {
  const columns = await columnsOf(table)
  const known: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (k !== 'id' && columns.has(k) && v !== undefined) known[k] = v
  }

  const existing = rowId
    ? await q1<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [rowId])
    : null
  const id = rowId ?? randomUUID()
  const at = hlc.tick()

  const row = await writeRow(table, id, known, Boolean(existing))
  // Resolved *after* the write: a row that has just been inserted cannot be walked up
  // to its workspace before it exists, and a batch with no workspace cannot be sent.
  const workspaceId = await workspaceOf(table, id).catch(() => null)

  /*
   * An insert records the row as it was actually written, not the fields that were
   * asked for. Columns with volatile defaults — `started_at`, and anything added
   * later — are resolved by whichever database runs the statement, so replaying an
   * op that left them out would give the row the day of the replay instead of the
   * day it happened. Taking them off the RETURNING row makes that correct by
   * construction rather than by remembering to list them.
   *
   * An update records only what it changed, which is what makes last-write-wins
   * per field mean anything.
   */
  const shared = syncableFields(table, existing ? known : (row ?? known))
  await stamp(table, id, Object.keys(shared), at)

  // A row that has been deleted and is now being written again by hand is genuinely
  // being recreated, so the tombstone has to go — otherwise this device would refuse
  // its own row when it came back around from a peer.
  if (existing === null) {
    await exec(
      `UPDATE sync_row SET deleted_hlc = NULL WHERE table_name = $1 AND row_id = $2`,
      [table, id]
    )
  }

  return {
    row,
    workspaceId: workspaceId ?? (table === 'workspace' ? id : null),
    op: Object.keys(shared).length > 0 || !existing
      ? { table, rowId: id, kind: 'put', fields: shared, hlc: at }
      : null
  }
}

/**
 * Record a row that a statement which had to stay atomic has already written.
 *
 * The escape hatch, and it has exactly one caller. The notification claim is an
 * `INSERT … ON CONFLICT DO NOTHING RETURNING id`, and that single statement *is* the
 * claim — splitting it into a read and a write would let two runs both decide they
 * were first, which is the duplicate-notification failure the table exists to
 * prevent. So the write happens as it always did, and the op is taken from the row
 * afterwards rather than built before it.
 *
 * Do not reach for this to avoid converting a call site. It is only correct where
 * atomicity genuinely forbids going through `putLocal()`.
 */
export async function stampExisting(
  table: SyncedTable,
  rowId: string,
  /** Adoption passes the genesis stamp; a real write leaves this off. */
  stampAt?: string
): Promise<LocalWrite> {
  const row = await q1<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = $1`, [rowId])
  if (!row) return { row: null, workspaceId: null, op: null }

  const at = stampAt ?? hlc.tick()
  const shared = syncableFields(table, row)
  await stamp(table, rowId, Object.keys(shared), at)
  return {
    row,
    workspaceId: await workspaceOf(table, rowId).catch(() => null),
    op: { table, rowId, kind: 'put', fields: shared, hlc: at }
  }
}

/** Delete a row because somebody on this machine asked for it. */
export async function deleteLocal(table: SyncedTable, rowId: string): Promise<LocalWrite> {
  const at = hlc.tick()
  const workspaceId = await workspaceOf(table, rowId).catch(() => null)

  /*
   * Only the parent delete becomes an op — a cascade is a deterministic function of
   * the schema, so every device performs the same one itself. The tombstones,
   * though, have to cover everything the cascade takes with it: a note created on
   * the phone while this Mac deleted its project would otherwise arrive later and
   * fail its foreign key, or worse, be inserted under a project that no longer
   * exists anywhere else.
   */
  const doomed = await descendants(table, rowId)
  await exec(`DELETE FROM ${table} WHERE id = $1`, [rowId])
  await tombstone(table, rowId, at)
  for (const child of doomed) await tombstone(child.table, child.id, at)

  return {
    row: null,
    workspaceId,
    op: { table, rowId, kind: 'delete', hlc: at }
  }
}

/* ------------------------------------------------------------------ *
 * A write that arrived from somewhere else
 * ------------------------------------------------------------------ */

/**
 * Apply one op that came off a transport.
 *
 * The differences from a local write are exactly two: it is resolved against what is
 * already here (last-write-wins, per field, on hlc order), and it produces no new op
 * — it is already in the log it arrived on. Everything else, including the derived
 * effects that happen above this, is identical.
 */
export type ApplyResult =
  /** Written. */
  | 'applied'
  /** Correctly ignored: it lost on the clock, or its row is tombstoned. */
  | 'skipped'
  /**
   * Its parent is not here. Possibly not yet — a stream can deliver a child before
   * the row it hangs off, and an adopted row carries the oldest stamp there is even
   * when what it references was written later. The caller retries these once the
   * rest of the pass has landed; one that still cannot be placed is describing a
   * branch that is genuinely gone.
   */
  | 'deferred'

export async function applyRemoteOp(op: Op): Promise<ApplyResult> {
  if (!isSynced(op.table)) return 'skipped'
  hlc.observe(op.hlc)

  const state = await stateOf(op.table, op.rowId)

  if (op.kind === 'delete') {
    // A delete only loses to a write that is genuinely newer than it, which is the
    // case where somebody edited the row after it was deleted elsewhere.
    const doomed = await descendants(op.table, op.rowId)
    await exec(`DELETE FROM ${op.table} WHERE id = $1`, [op.rowId])
    await tombstone(op.table, op.rowId, op.hlc)
    for (const child of doomed) await tombstone(child.table, child.id, op.hlc)
    return 'applied'
  }

  // The row was deleted after this write was made. Nothing here resurrects it.
  if (state?.deleted_hlc && state.deleted_hlc > op.hlc) return 'skipped'

  const columns = await columnsOf(op.table)
  const winning: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(op.fields ?? {})) {
    if (k === 'id' || !columns.has(k)) continue
    if (hlc.isNewer(op.hlc, state?.field_hlc?.[k])) winning[k] = revive(k, v)
  }

  const exists = await q1<{ id: string }>(
    `SELECT id FROM ${op.table} WHERE id = $1`,
    [op.rowId]
  )
  if (exists && Object.keys(winning).length === 0) return 'skipped'

  try {
    await writeRow(op.table, op.rowId, winning, Boolean(exists))
  } catch (error) {
    /*
     * The parent is gone on this device and its delete has not reached us yet — the
     * op is describing a branch that is already dead. Dropping it is correct; when
     * the parent's delete arrives the tombstone will make that permanent.
     */
    /*
     * Two ways an op can describe a row that cannot exist here, both of which mean
     * the same thing: the write it depends on is not here (yet, or ever).
     *
     *   23503 — its parent is gone on this device.
     *   23502 — it is a partial update for a row that was never created here, so
     *           there is nothing to merge it into and its NOT NULL columns are empty.
     *
     * Dropping is correct rather than merely convenient. A hybrid logical clock
     * guarantees the creating op is causally earlier than any edit of it, so an edge
     * that reaches this line is describing a branch that is already dead.
     */
    if (isForeignKeyViolation(error) || isMissingRequired(error)) return 'deferred'
    throw error
  }

  await stamp(op.table, op.rowId, Object.keys(winning), op.hlc)
  if (state?.deleted_hlc) {
    await exec(
      `UPDATE sync_row SET deleted_hlc = NULL WHERE table_name = $1 AND row_id = $2`,
      [op.table, op.rowId]
    )
  }
  return 'applied'
}

/**
 * Apply a run of ops, retrying the ones whose parent had not arrived yet.
 *
 * Passes until nothing more lands. Bounded by the fact that each pass must place at
 * least one op to earn another, so the worst case is the depth of the schema rather
 * than anything unbounded. What is left after that is dropped: an op that cannot be
 * placed once everything else has been is describing a row whose branch is gone.
 */
export async function applyRun(ops: Op[]): Promise<{ applied: number; dropped: number }> {
  let queue = ops
  let applied = 0

  while (queue.length > 0) {
    const deferred: Op[] = []
    for (const op of queue) {
      const result = await applyRemoteOp(op)
      if (result === 'applied') applied += 1
      else if (result === 'deferred') deferred.push(op)
    }
    if (deferred.length === queue.length) {
      // `PM_TRACE_DROPS=1` names them. Worth having: an op that cannot be placed
      // once everything else has been is either a dead branch or a bug in what a
      // table declares as its owner, and the two look identical from the outside.
      if (process.env.PM_TRACE_DROPS) {
        for (const op of deferred) {
          console.error('DROP', op.table, op.rowId, JSON.stringify(op.fields).slice(0, 200))
        }
      }
      return { applied, dropped: deferred.length }
    }
    queue = deferred
  }
  return { applied, dropped: 0 }
}

/** JSON has no date and no bigint; the columns do. */
function revive(column: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (/_at$/.test(column) && /^\d{4}-\d\d-\d\dT/.test(value)) return new Date(value)
  return value
}

function isForeignKeyViolation(error: unknown): boolean {
  const { code } = (error ?? {}) as { code?: string }
  return code === '23503'
}

function isMissingRequired(error: unknown): boolean {
  const { code } = (error ?? {}) as { code?: string }
  return code === '23502'
}
