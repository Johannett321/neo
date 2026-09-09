import { ipcMain } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import { isSynced } from '@shared/tables'
import type { SyncedTable } from '@shared/tables'
import { q, q1, writeCount } from '../db/client'
import { deleteLocal, putLocal, stampExisting } from '../db/apply'
import { announceChange } from '../lib/changes'

/**
 * Every registered handler, kept so the process can call its own channels.
 *
 * The assistant's tools are the same channels the renderer uses rather than a second
 * set of writes beside them, which is what makes an assistant-made task identical to
 * a hand-made one: it logs activity, rewrites the Markdown mirror and honours the
 * column allowlist because it *is* that code path, not a copy of it that will drift.
 */
const registry = new Map<string, (input: unknown) => Promise<unknown>>()

/**
 * Registered once and called two ways: from the renderer over IPC, and from inside
 * this process by `invokeChannel()`.
 *
 * It used to wrap each call in `withBatch()`, so that saving a task and the activity
 * line describing it became one atomic unit on the wire. Rows travel on their own
 * now, which loses that guarantee and is worth being honest about: a device can see
 * the task a moment before the line that says who made it. Both arrive in the same
 * page and in dependency order, so what it costs is a fraction of a second of a
 * partial story rather than a lasting one.
 */
export function handle<C extends Channel>(
  channel: C,
  fn: (input: Input<C>) => Promise<Output<C>> | Output<C>
): void {
  const run = async (input: unknown): Promise<Output<C>> => fn(input as Input<C>)
  registry.set(channel, run as (input: unknown) => Promise<unknown>)
  ipcMain.handle(channel, async (_event, input) => run(input))
}

/**
 * Call a channel from inside the main process. Channels that take an input require
 * one, exactly as they do from the renderer — the same tuple trick, for the same
 * reason: a workspace-scoped channel called with nothing would quietly return
 * everything.
 *
 * This is also the one place that knows a write happened with nobody in the renderer
 * waiting on it. A click resolves a mutation and the mutation invalidates the cache;
 * a tool call does not, so the window is told here instead — which is what makes a
 * project the assistant creates, or a card Claude Desktop moves, appear on the screen
 * while it is happening rather than the next time you navigate back to it. The
 * database is asked whether anything actually changed rather than the channel name
 * being consulted, so a read announces nothing and no list has to be kept up to date.
 */
export async function invokeChannel<C extends Channel>(
  channel: C,
  ...args: Input<C> extends void ? [input?: undefined] : [input: Input<C>]
): Promise<Output<C>> {
  const fn = registry.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  const before = writeCount()
  try {
    return (await fn(args[0])) as Output<C>
  } finally {
    // In `finally`, because a call that wrote and then threw still moved something,
    // and a screen showing half of it is better than one showing none of it.
    if (writeCount() !== before) announceChange()
  }
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * Pull an explicit allowlist of fields off a draft. Handlers name every column they
 * are willing to write, so nothing a renderer sends can reach a column by accident.
 */
export function pick<T extends object, K extends keyof T>(src: T, keys: K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = src[k]
    if (v !== undefined) out[k as string] = v
  }
  return out
}

/**
 * Insert or update by id, returning the resulting row.
 *
 * The one place a handler writes through. It goes via `putLocal()`, which puts the
 * row down *and* marks it as something the sync server has not been given — so
 * nothing above this line has to know that syncing exists.
 *
 * A table that is not synced (`summary_part`, `setting`) takes the plain path. Those
 * hold facts about this machine, and a fact about this machine is nobody else's.
 */
export async function upsert<R>(
  table: string,
  fields: Record<string, unknown>,
  id?: string,
  extraOnUpdate = ''
): Promise<R> {
  if (!isSynced(table)) return upsertRaw<R>(table, fields, id, extraOnUpdate)

  const columns: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) columns[snake(k)] = v

  /*
   * `updated_at = now()` becomes a value rather than staying a default. A default is
   * evaluated by whichever database runs the statement, so a row written here and
   * replayed on the other Mac tomorrow would claim to have been touched tomorrow.
   */
  if (/updated_at/.test(extraOnUpdate)) columns.updated_at = new Date()

  if (id) {
    const exists = await q1<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [id])
    if (!exists) throw new Error(`${table} ${id} not found`)
  }

  const write = await putLocal(table as SyncedTable, id, columns)
  if (!write.row) throw new Error(id ? `${table} ${id} not found` : `Could not insert into ${table}`)
  return write.row as R
}

/** The plain path, for the tables that deliberately never leave this machine. */
async function upsertRaw<R>(
  table: string,
  fields: Record<string, unknown>,
  id?: string,
  extraOnUpdate = ''
): Promise<R> {
  const entries = Object.entries(fields)
  if (id) {
    if (entries.length === 0) {
      const existing = await q1<R>(`SELECT * FROM ${table} WHERE id = $1`, [id])
      if (!existing) throw new Error(`${table} ${id} not found`)
      return existing
    }
    const sets = entries.map(([k], i) => `${snake(k)} = $${i + 2}`).join(', ')
    const row = await q1<R>(
      `UPDATE ${table} SET ${sets}${extraOnUpdate ? `, ${extraOnUpdate}` : ''} WHERE id = $1 RETURNING *`,
      [id, ...entries.map(([, v]) => v)]
    )
    if (!row) throw new Error(`${table} ${id} not found`)
    return row
  }
  const cols = entries.map(([k]) => snake(k)).join(', ')
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ')
  const row = await q1<R>(
    entries.length
      ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`
      : `INSERT INTO ${table} DEFAULT VALUES RETURNING *`,
    entries.map(([, v]) => v)
  )
  if (!row) throw new Error(`Could not insert into ${table}`)
  return row
}

/**
 * Record a write that had to be made by one atomic statement. See `stampExisting()`.
 */
export async function noteWrite(table: string, id: string): Promise<void> {
  if (!isSynced(table)) return
  await stampExisting(table as SyncedTable, id)
}

/**
 * Update every row matching a column, one row at a time.
 *
 * The bulk `UPDATE … WHERE folder_id = $1` statements this replaces moved several
 * rows in one go and left no record of which. Each row has to be marked on its own —
 * otherwise two Macs tidying different folders would hand over one undifferentiated
 * change and one of them would lose everything it did.
 *
 * These are all small sets: the projects in a folder, the columns on a board, the
 * notes filed in one place.
 */
export async function updateWhere(
  table: string,
  match: Record<string, unknown>,
  fields: Record<string, unknown>
): Promise<string[]> {
  const where = Object.keys(match)
    .map((k, i) => `${snake(k)} ${match[k] === null ? 'IS NULL' : `= $${i + 1}`}`)
    .join(' AND ')
  const params = Object.values(match).filter((v) => v !== null)
  const rows = await q<{ id: string }>(`SELECT id FROM ${table} WHERE ${where}`, params)
  for (const row of rows) await upsert(table, fields, row.id)
  return rows.map((r) => r.id)
}

/** Delete every row matching a column, each with its own tombstone. */
export async function removeWhere(
  table: string,
  match: Record<string, unknown>
): Promise<number> {
  const where = Object.keys(match).map((k, i) => `${snake(k)} = $${i + 1}`).join(' AND ')
  const rows = await q<{ id: string }>(`SELECT id FROM ${table} WHERE ${where}`, Object.values(match))
  for (const row of rows) await remove(table, row.id)
  return rows.length
}

/**
 * Delete a row by id, recording the tombstone that lets other devices learn of it.
 *
 * Handlers must use this rather than `DELETE FROM` directly: a bare delete leaves no
 * trace, and a row that vanishes without a trace comes back the next time a device
 * that still has it syncs.
 */
export async function remove(table: string, id: string): Promise<void> {
  if (!isSynced(table)) {
    await q1(`DELETE FROM ${table} WHERE id = $1`, [id])
    return
  }
  await deleteLocal(table as SyncedTable, id)
}

/**
 * Apply an explicit ordering to a set of rows in one statement.
 *
 * Numbered from one rather than zero, everywhere, so that zero is left free to mean
 * "nobody has ever said where this goes". Project cards read it that way — an
 * unplaced one falls back to the order the page always used — and nothing else cares
 * which integer it got, only that its neighbours got the ones either side.
 */
export async function reorder(table: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return

  if (!isSynced(table)) {
    const values = ids.map((_, i) => `($${i + 1}::uuid, ${i + 1})`).join(', ')
    await q1(
      `UPDATE ${table} SET sort_order = v.ord
       FROM (VALUES ${values}) AS v(id, ord)
       WHERE ${table}.id = v.id`,
      ids
    )
    return
  }

  /*
   * A row at a time rather than the one statement it used to be. A position only
   * means anything among its neighbours, so a drag has to travel as the whole visible
   * set — and each row has to be marked on its own, or two Macs rearranging different
   * folders would clobber one another's ordering wholesale.
   *
   * These are cards on one page: a dozen rows, not a table scan.
   */
  for (const [index, id] of ids.entries()) {
    await putLocal(table as SyncedTable, id, { sort_order: index + 1 })
  }
}
