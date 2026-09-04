import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { DDL, MIGRATIONS } from './ddl'

let pg: PGlite | null = null
let root = ''

/**
 * Everything lives in a plain, visible folder you own — no container, no daemon,
 * no opaque application-support directory. Back it up by copying it.
 */
export function dataRoot(): string {
  if (root) return root
  let documents: string
  try {
    documents = app.getPath('documents')
  } catch {
    documents = join(homedir(), 'Documents')
  }

  root = join(documents, 'Neo')

  // The app used to be called ProjectManager. Move the folder across on first launch
  // under the new name, but never on top of an existing one.
  const legacy = join(documents, 'ProjectManager')
  if (!existsSync(root) && existsSync(legacy)) {
    try {
      renameSync(legacy, root)
      console.log(`Moved your data from ${legacy} to ${root}`)
    } catch (error) {
      console.warn('Could not move the data folder, continuing with the old one:', error)
      root = legacy
    }
  }

  mkdirSync(root, { recursive: true })
  return root
}

export const dbDir = (): string => join(dataRoot(), 'db')
export const iconDir = (): string => join(dataRoot(), 'icons')
export const markdownDir = (): string => join(dataRoot(), 'markdown')
export const exportDir = (): string => join(dataRoot(), 'exports')

/**
 * An abrupt exit — a force quit, a crash, two copies of the app opened on the same
 * folder — can leave a b-tree index inconsistent. The row data survives; only the
 * index is wrong, and rebuilding it is enough. Postgres reports this as XX002, so
 * the first launch after such an exit repairs itself instead of refusing to start.
 */
async function applySchema(client: PGlite): Promise<void> {
  try {
    await client.exec(DDL)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'XX002') throw error
    console.warn('Damaged index found on startup, rebuilding it…')
    await client.exec('REINDEX TABLE pg_catalog.pg_constraint')
    await client.exec('REINDEX SYSTEM postgres')
    await client.exec(DDL)
    console.warn('Index rebuilt; your data was not affected.')
  }
  for (const statement of MIGRATIONS) await client.query(statement)
}

/**
 * PGlite has no lock of its own, and Electron's single-instance lock is keyed on the
 * bundle identifier — so a development build and a packaged build, which have different
 * identifiers, would happily open the same folder and corrupt it. The guard belongs on
 * the data, not on the application.
 */
function claimDataFolder(): void {
  const lock = join(dataRoot(), '.lock')
  try {
    const holder = Number(readFileSync(lock, 'utf8').trim())
    if (holder && holder !== process.pid) {
      try {
        process.kill(holder, 0) // Throws when no such process exists.
        throw new Error(
          'Neo is already open in another window (process ' +
            `${holder}). Close it before opening this one — two copies writing the same ` +
            'folder will damage the database.'
        )
      } catch (error) {
        // A lock left behind by a crash names a process that is gone; take it over.
        if (error instanceof Error && error.message.startsWith('Neo is already open')) throw error
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Neo is already open')) throw error
    // No lock file at all, which is the normal case.
  }
  writeFileSync(lock, String(process.pid))
}

function releaseDataFolder(): void {
  try {
    const lock = join(dataRoot(), '.lock')
    if (Number(readFileSync(lock, 'utf8').trim()) === process.pid) rmSync(lock, { force: true })
  } catch {
    // Nothing to release.
  }
}

export async function initDb(): Promise<PGlite> {
  if (pg) return pg
  claimDataFolder()
  mkdirSync(dbDir(), { recursive: true })
  pg = new PGlite(dbDir())
  await pg.waitReady
  await applySchema(pg)
  return pg
}

export function db(): PGlite {
  if (!pg) throw new Error('Database accessed before initDb()')
  return pg
}

export async function closeDb(): Promise<void> {
  if (pg) {
    await pg.close()
    pg = null
  }
  releaseDataFolder()
}

export async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(sql, params as never[])
  return res.rows
}

export async function q1<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params)
  return rows[0] ?? null
}

export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await db().query(sql, params as never[])
}

/** timestamptz comes back as a Date; the renderer only ever deals in ISO strings. */
export const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : new Date(String(v)).toISOString()

export const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v))

/** Local calendar day, not UTC — "due today" must mean today where the user is sitting. */
export function today(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d)
  dt.setDate(dt.getDate() + days)
  return today(dt)
}

/** Whole days between two YYYY-MM-DD dates, ignoring time and DST entirely. */
export function daysBetween(from: string, to: string): number {
  const parse = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

/** Days since an ISO timestamp, in local calendar days. */
export function daysSince(ts: string | Date | null): number | null {
  if (!ts) return null
  const d = ts instanceof Date ? ts : new Date(ts)
  return daysBetween(today(d), today())
}
