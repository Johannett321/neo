import { randomUUID } from 'node:crypto'
import type { RowChange, SyncedTable } from '@shared/tables'
import { TABLES, isSynced } from '@shared/tables'
import { q, q1, exec } from './client'
import { announceWrite } from './wake'

/**
 * The only thing in the application that writes a domain table.
 *
 * A click, an assistant tool call, a task created from Claude Desktop and a row
 * arriving from the sync server all end up here, which is what makes them the same
 * write rather than four that resemble each other. Everything above this decides
 * *what* to write; this decides whether it wins and puts it down.
 *
 * A local write also records that the row has changed, in `sync_dirty`. That happens
 * whether or not this machine has ever heard of a sync server — Local and synced are
 * the same code path, and the day somebody signs in, everything they have ever made
 * is already marked as something to hand over.
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
 * It also gives forward compatibility for nothing: a row from a newer version of Neo
 * mentioning a column this one has never heard of has that field dropped here rather
 * than failing the whole page.
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
 * Every synced table reaches one; the workspace is the unit of sync and later of
 * sharing, exactly as it is already the unit of isolation on every scoped channel.
 * Resolved *before* a delete, because afterwards there is nothing left to ask.
 */
export async function workspaceOf(table: SyncedTable, rowId: string): Promise<string | null> {
  let current: SyncedTable = table
  let id: string | null = rowId
  // The chain is four deep at its longest (transcript_cue → recording → meeting →
  // project → workspace); the guard is for a schema change that accidentally makes it
  // circular, which should not cost the app its main process.
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
 * What is waiting to go, and what has gone
 * ------------------------------------------------------------------ */

/**
 * Mark a row as something the sync server has not been given.
 *
 * `changed_at` is taken here rather than read off the row, because most tables have
 * no `updated_at` of their own and the ones that do mean something slightly different
 * by it. It is this machine's wall clock, and it is the whole of the conflict rule.
 */
async function markDirty(
  table: string,
  rowId: string,
  workspaceId: string | null,
  deleted: boolean,
  at: Date
): Promise<void> {
  await exec(
    `INSERT INTO sync_dirty (table_name, row_id, workspace_id, changed_at, deleted)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (table_name, row_id) DO UPDATE
        SET workspace_id = COALESCE(EXCLUDED.workspace_id, sync_dirty.workspace_id),
            changed_at   = EXCLUDED.changed_at,
            deleted      = EXCLUDED.deleted`,
    [table, rowId, workspaceId, at, deleted]
  )
}

async function tombstone(table: string, rowId: string, at: Date): Promise<void> {
  await exec(
    `INSERT INTO sync_tombstone (table_name, row_id, deleted_at) VALUES ($1, $2, $3)
     ON CONFLICT (table_name, row_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
    [table, rowId, at]
  )
}

const tombstoneOf = async (table: string, rowId: string): Promise<Date | null> => {
  const row = await q1<{ deleted_at: Date }>(
    `SELECT deleted_at FROM sync_tombstone WHERE table_name = $1 AND row_id = $2`,
    [table, rowId]
  )
  return row?.deleted_at ? new Date(row.deleted_at) : null
}

const dirtyAt = async (table: string, rowId: string): Promise<Date | null> => {
  const row = await q1<{ changed_at: Date }>(
    `SELECT changed_at FROM sync_dirty WHERE table_name = $1 AND row_id = $2`,
    [table, rowId]
  )
  return row?.changed_at ? new Date(row.changed_at) : null
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
  workspaceId: string | null
  row: Record<string, unknown> | null
}

/**
 * Insert or update a row because somebody on this machine asked for it.
 *
 * A local write is unconditional — nothing here compares it against anything, because
 * what is on this screen is what the person is looking at. It is the *server* that
 * decides a conflict, later, on the timestamp this records.
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
  const at = new Date()

  const row = await writeRow(table, id, known, Boolean(existing))
  // Resolved *after* the write: a row that has just been inserted cannot be walked up
  // to its workspace before it exists, and a change with no workspace cannot be sent.
  const workspaceId = (await workspaceOf(table, id).catch(() => null))
    ?? (table === 'workspace' ? id : null)

  await markDirty(table, id, workspaceId, false, at)

  // A row that has been deleted and is now being written again by hand is genuinely
  // being recreated, so the tombstone has to go — otherwise this device would refuse
  // its own row when it came back around from the server.
  if (!existing) {
    await exec(`DELETE FROM sync_tombstone WHERE table_name = $1 AND row_id = $2`, [table, id])
  }

  announceWrite()
  return { row, workspaceId }
}

/**
 * Record a row that a statement which had to stay atomic has already written.
 *
 * The escape hatch, and it has exactly one caller. The notification claim is an
 * `INSERT … ON CONFLICT DO NOTHING RETURNING id`, and that single statement *is* the
 * claim — splitting it into a read and a write would let two runs both decide they
 * were first, which is the duplicate-notification failure the table exists to
 * prevent. So the write happens as it always did, and it is marked afterwards rather
 * than as part of it.
 *
 * Do not reach for this to avoid converting a call site. It is only correct where
 * atomicity genuinely forbids going through `putLocal()`.
 */
export async function stampExisting(
  table: SyncedTable,
  rowId: string,
  /** Adoption passes the row's own age; a real write leaves this off. */
  changedAt?: Date
): Promise<LocalWrite> {
  const row = await q1<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = $1`, [rowId])
  if (!row) return { row: null, workspaceId: null }

  const workspaceId = (await workspaceOf(table, rowId).catch(() => null))
    ?? (table === 'workspace' ? rowId : null)
  await markDirty(table, rowId, workspaceId, false, changedAt ?? new Date())
  announceWrite()
  return { row, workspaceId }
}

/** Delete a row because somebody on this machine asked for it. */
export async function deleteLocal(table: SyncedTable, rowId: string): Promise<LocalWrite> {
  const at = new Date()
  const workspaceId = (await workspaceOf(table, rowId).catch(() => null))
    ?? (table === 'workspace' ? rowId : null)

  /*
   * A cascade is deterministic, so every device performs the same one itself — but
   * the deletes that travel have to cover everything it takes with it. A note created
   * on the phone while this Mac deleted its project would otherwise arrive later and
   * fail its foreign key, or worse, be inserted under a project that no longer exists
   * anywhere else.
   */
  const doomed = await descendants(table, rowId)
  await exec(`DELETE FROM ${table} WHERE id = $1`, [rowId])

  await tombstone(table, rowId, at)
  await markDirty(table, rowId, workspaceId, true, at)
  for (const child of doomed) {
    await tombstone(child.table, child.id, at)
    if (isSynced(child.table)) await markDirty(child.table, child.id, workspaceId, true, at)
  }

  announceWrite()
  return { row: null, workspaceId }
}

/* ------------------------------------------------------------------ *
 * A write that arrived from the sync server
 * ------------------------------------------------------------------ */

/**
 * Apply one row that came off the wire.
 *
 * The differences from a local write are exactly two: it is resolved against what is
 * already here, and it does not mark anything dirty — the server already has it.
 * Everything else is identical.
 */
export type ApplyResult =
  /** Written. */
  | 'applied'
  /** Correctly ignored: this device holds something newer. */
  | 'skipped'
  /**
   * Its parent is not here. Possibly not yet — a page is ordered by revision, so the
   * row a change refers to is normally earlier in it, but the very first pull of a
   * workspace can straddle a page boundary. The caller retries these once the rest of
   * the page has landed; one that still cannot be placed is describing a branch that
   * is genuinely gone.
   */
  | 'deferred'

export async function applyRemote(change: RowChange): Promise<ApplyResult> {
  if (!isSynced(change.table)) return 'skipped'
  const changedAt = new Date(change.changedAt)

  /*
   * Unsent local work is the one thing that beats the server, and only when it is
   * genuinely newer. This is the case where a laptop has been closed for a week: it
   * has edits nobody has seen, and the pull that reaches it must not quietly discard
   * them before they have had their chance to be pushed.
   */
  const mine = await dirtyAt(change.table, change.id)
  if (mine && mine >= changedAt) return 'skipped'

  if (change.deleted) {
    const doomed = await descendants(change.table, change.id)
    await exec(`DELETE FROM ${change.table} WHERE id = $1`, [change.id])
    await tombstone(change.table, change.id, changedAt)
    for (const child of doomed) await tombstone(child.table, child.id, changedAt)
    await exec(`DELETE FROM sync_dirty WHERE table_name = $1 AND row_id = $2`,
      [change.table, change.id])
    return 'applied'
  }

  // The row was deleted here after this write was made. Nothing resurrects it.
  const dead = await tombstoneOf(change.table, change.id)
  if (dead && dead > changedAt) return 'skipped'

  const columns = await columnsOf(change.table)
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(change.fields)) {
    if (k === 'id' || !columns.has(k)) continue
    fields[k] = revive(k, v)
  }

  const exists = await q1<{ id: string }>(
    `SELECT id FROM ${change.table} WHERE id = $1`, [change.id]
  )

  try {
    await writeRow(change.table, change.id, fields, Boolean(exists))
  } catch (error) {
    /*
     * Two ways a row can describe something that cannot exist here, both of which
     * mean the same thing: the row it depends on is not here (yet, or ever).
     *
     *   23503 — its parent is gone on this device.
     *   23502 — it is a partial row for something that was never created here, so
     *           there is nothing to merge it into and its NOT NULL columns are empty.
     */
    if (isForeignKeyViolation(error) || isMissingRequired(error)) return 'deferred'
    throw error
  }

  // Applied cleanly, so whatever this device was still holding for that row has been
  // superseded — and the tombstone, if there was one, has lost.
  await exec(`DELETE FROM sync_dirty WHERE table_name = $1 AND row_id = $2`,
    [change.table, change.id])
  if (dead) {
    await exec(`DELETE FROM sync_tombstone WHERE table_name = $1 AND row_id = $2`,
      [change.table, change.id])
  }
  return 'applied'
}

/**
 * Apply a page of changes, retrying the ones whose parent had not arrived yet.
 *
 * Passes until nothing more lands. Bounded by the fact that each pass must place at
 * least one row to earn another, so the worst case is the depth of the schema rather
 * than anything unbounded. What is left after that is dropped: a row that cannot be
 * placed once everything else has been is describing a branch that is gone.
 */
export async function applyRun(
  changes: RowChange[]
): Promise<{ applied: number; dropped: number }> {
  let queue = changes
  let applied = 0

  while (queue.length > 0) {
    const deferred: RowChange[] = []
    for (const change of queue) {
      const result = await applyRemote(change)
      if (result === 'applied') applied += 1
      else if (result === 'deferred') deferred.push(change)
    }
    if (deferred.length === queue.length) {
      // `PM_TRACE_DROPS=1` names them. Worth having: a row that cannot be placed once
      // everything else has been is either a dead branch or a bug in what a table
      // declares as its owner, and the two look identical from the outside.
      if (process.env.PM_TRACE_DROPS) {
        for (const change of deferred) {
          console.error('DROP', change.table, change.id,
            JSON.stringify(change.fields).slice(0, 200))
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
