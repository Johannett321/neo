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
 * An abrupt exit — a force quit, a crash, a hot reload that kills the process
 * mid-write, two copies of the app opened on the same folder — can leave a b-tree
 * index inconsistent. Row data is never what is damaged; only the index is wrong,
 * and rebuilding it is enough.
 */
async function reindexCatalog(client: PGlite): Promise<void> {
  await client.exec('REINDEX TABLE pg_catalog.pg_constraint')
  await client.exec('REINDEX TABLE pg_catalog.pg_trigger')
  await client.exec('REINDEX SYSTEM postgres')
}

/** True for the family of errors that mean "the catalog cannot find itself". */
function isCatalogDamage(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  return code === 'XX002' || /cache lookup failed/i.test(message ?? '')
}

/**
 * Foreign-key triggers whose constraint has gone missing.
 *
 * Postgres reports XX002 at startup when it *notices* damage, and the recovery above
 * handles that. It does not always notice. A foreign key can lose its `pg_constraint`
 * row while the triggers that enforce it survive, and the database then opens
 * perfectly and fails the first time a row is inserted into that table:
 * `cache lookup failed for constraint 25004`, raised from `ri_LoadConstraintInfo`
 * inside the INSERT — and every insert into that table fails the same way afterwards.
 *
 * This is deliberately a sequential scan and not `pg_get_constraintdef`, which returns
 * null for a constraint it cannot find rather than complaining, and so sails straight
 * past exactly the damage worth catching.
 */
export async function orphanedForeignKeys(client: PGlite = db()): Promise<string[]> {
  const res = await client.query<{ tbl: string }>(
    `SELECT DISTINCT t.tgrelid::regclass::text AS tbl
     FROM pg_trigger t
     WHERE t.tgconstraint <> 0
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.oid = t.tgconstraint)
     ORDER BY 1`
  )
  return res.rows.map((r) => r.tbl)
}

/**
 * Delete the stranded triggers that cannot be enforcing anything, and only those.
 *
 * A trigger left behind by a table that was dropped points at a `tgconstrrelid` no
 * row in `pg_class` answers to any more. There is no relationship left for it to
 * check — the other side of it does not exist — so it is debris, and all it does is
 * make every insert into its own table fail. Removing it is the whole repair.
 *
 * A trigger whose referenced table *is* still there is a different animal: that
 * foreign key was real, and a dropped `pg_constraint` row takes the shape of the key
 * with it — modern Postgres keeps it there and nowhere else, so nothing survives to
 * rebuild it from. Deleting those would let writes through while quietly abandoning
 * referential integrity, so they are reported and left alone.
 */
export async function clearStrandedTriggers(client: PGlite): Promise<number> {
  const res = await client.query<{ tgname: string }>(
    `DELETE FROM pg_trigger t
     WHERE t.tgconstraint <> 0
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.oid = t.tgconstraint)
       AND NOT EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.tgconstrrelid)
     RETURNING t.tgname`
  )
  return res.rows.length
}

/** Resolves true when it removed something, which the caller has to act on. */
async function applySchema(client: PGlite): Promise<boolean> {
  try {
    await client.exec(DDL)
  } catch (error) {
    if (!isCatalogDamage(error)) throw error
    console.warn('Damaged index found on startup, rebuilding it…')
    await reindexCatalog(client)
    await client.exec(DDL)
    console.warn('Index rebuilt; your data was not affected.')
  }
  for (const statement of MIGRATIONS) await client.query(statement)

  // Catch the damage that opening the database cleanly does not reveal, here at
  // launch rather than the first time someone tries to add a task.
  let damaged = await orphanedForeignKeys(client)
  if (damaged.length === 0) return false

  // An index that merely lost track of rows that are still there is repaired by
  // rebuilding it, so try the cheap and complete fix first.
  console.warn(`Foreign keys on ${damaged.join(', ')} have lost their constraint; reindexing…`)
  await reindexCatalog(client)
  damaged = await orphanedForeignKeys(client)
  if (damaged.length === 0) {
    console.warn('Rebuilt; your data was not affected.')
    return false
  }

  const cleared = await clearStrandedTriggers(client)
  if (cleared > 0) console.warn(`Removed ${cleared} trigger(s) left behind by a dropped table.`)

  damaged = await orphanedForeignKeys(client)
  if (damaged.length > 0) {
    console.error(
      `The database in ${dataRoot()} has a damaged system catalog: ${damaged.join(', ')} ` +
        'will refuse every insert with "cache lookup failed for constraint", and the key ' +
        'that was lost cannot be rebuilt. Every row is intact and readable — export from ' +
        'Settings, then start a new folder.'
    )
  } else {
    console.warn('Repaired; your data was not affected.')
  }
  return cleared > 0
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

  if (await applySchema(pg)) {
    /*
     * Writing to the catalog directly does not invalidate the relation cache, and by
     * the time the repair runs this connection has already read `task` — so it holds
     * the old list of triggers, including the ones just deleted, and every insert
     * would go on failing until the next launch. Reconnecting is what makes the
     * repair take effect now rather than the second time you open the app.
     */
    await pg.close()
    pg = new PGlite(dbDir())
    await pg.waitReady
    await applySchema(pg)
  }
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
