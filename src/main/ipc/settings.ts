import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import type { Settings } from '@shared/types'
import { db, dataRoot, exportDir, exec, markdownDir, q } from '../db/client'
import { DDL, MIGRATIONS } from '../db/ddl'
import { THRESHOLDS } from '../lib/health'
import { mirrorAll } from '../lib/markdown'
import { loadSampleData } from '../lib/sample'
import { handle } from './util'

const DEFAULTS = {
  theme: 'system' as const,
  staleAfterDays: THRESHOLDS.staleAfterDays,
  horizonDays: 21
}

async function readSettings(): Promise<Settings> {
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM setting')
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))

  // A remembered workspace can be deleted from under us; fall back to the first one.
  const workspaces = await q<{ id: string }>('SELECT id FROM workspace ORDER BY sort_order, name')
  const remembered = stored.activeWorkspaceId
  const activeWorkspaceId =
    remembered && workspaces.some((w) => w.id === remembered)
      ? remembered
      : (workspaces[0]?.id ?? '')

  const num = (k: keyof typeof DEFAULTS, fallback: number): number => {
    const parsed = Number(stored[k])
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    dataDir: dataRoot(),
    markdownDir: markdownDir(),
    activeWorkspaceId,
    theme: (stored.theme as Settings['theme']) ?? DEFAULTS.theme,
    staleAfterDays: num('staleAfterDays', DEFAULTS.staleAfterDays),
    horizonDays: num('horizonDays', DEFAULTS.horizonDays)
  }
}

const TABLES = [
  'workspace', 'project', 'lane', 'person', 'membership',
  'task', 'note', 'decision', 'link', 'journal_entry', 'activity'
] as const

export function registerSettingsHandlers(): void {
  handle('settings:get', readSettings)

  handle('settings:save', async (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'dataDir' || key === 'markdownDir') continue
      await exec(
        `INSERT INTO setting (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      )
    }
    return readSettings()
  })

  handle('settings:revealData', async () => {
    await shell.openPath(dataRoot())
  })

  handle('settings:exportMarkdown', () => mirrorAll())

  handle('settings:exportJson', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const dump: Record<string, unknown[]> = {}
    for (const table of TABLES) dump[table] = await q<any>(`SELECT * FROM ${table}`)
    await mkdir(exportDir(), { recursive: true })
    const path = join(exportDir(), `neo-${new Date().toISOString().slice(0, 10)}.json`)
    await writeFile(path, JSON.stringify({ exportedAt: new Date().toISOString(), data: dump }, null, 2), 'utf8')
    return { path }
  })

  handle('settings:loadSample', () => loadSampleData())

  handle('settings:wipe', async () => {
    for (const table of TABLES) await exec(`DROP TABLE IF EXISTS ${table} CASCADE`)
    await exec('DROP TABLE IF EXISTS setting CASCADE')
    await db().exec(DDL)
    for (const statement of MIGRATIONS) await db().query(statement)
  })

  handle('shell:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
