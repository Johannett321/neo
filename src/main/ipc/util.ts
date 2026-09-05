import { ipcMain } from 'electron'
import type { Channel, Input, Output } from '@shared/api'
import { q1 } from '../db/client'

/**
 * Every registered handler, kept so the process can call its own channels.
 *
 * The assistant's tools are the same channels the renderer uses rather than a second
 * set of writes beside them, which is what makes an assistant-made task identical to
 * a hand-made one: it logs activity, rewrites the Markdown mirror and honours the
 * column allowlist because it *is* that code path, not a copy of it that will drift.
 */
const registry = new Map<string, (input: unknown) => Promise<unknown>>()

export function handle<C extends Channel>(
  channel: C,
  fn: (input: Input<C>) => Promise<Output<C>> | Output<C>
): void {
  registry.set(channel, async (input) => fn(input as Input<C>))
  ipcMain.handle(channel, async (_event, input) => fn(input as Input<C>))
}

/**
 * Call a channel from inside the main process. Channels that take an input require
 * one, exactly as they do from the renderer — the same tuple trick, for the same
 * reason: a workspace-scoped channel called with nothing would quietly return
 * everything.
 */
export async function invokeChannel<C extends Channel>(
  channel: C,
  ...args: Input<C> extends void ? [input?: undefined] : [input: Input<C>]
): Promise<Output<C>> {
  const fn = registry.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return (await fn(args[0])) as Output<C>
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

/** Insert or update by id, returning the resulting row. */
export async function upsert<R>(
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

/** Apply an explicit ordering to a set of rows in one statement. */
export async function reorder(table: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const values = ids.map((_, i) => `($${i + 1}::uuid, ${i})`).join(', ')
  await q1(
    `UPDATE ${table} SET sort_order = v.ord
     FROM (VALUES ${values}) AS v(id, ord)
     WHERE ${table}.id = v.id`,
    ids
  )
}
