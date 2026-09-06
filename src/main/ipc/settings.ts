import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { PANELS } from '@shared/panels'
import type { Settings } from '@shared/types'
import { db, dataRoot, exportDir, exec, markdownDir, q } from '../db/client'
import { DDL, MIGRATIONS } from '../db/ddl'
import { THRESHOLDS } from '../lib/attention'
import { mirrorAll } from '../lib/markdown'
import { loadSampleData } from '../lib/sample'
import { recordingDir } from '../lib/recording/store'
import { setGlass } from '../lib/glass'
import { handle } from './util'

const DEFAULTS = {
  theme: 'system' as const,
  /*
   * Enough that the desktop is unmistakably there and not so much that a note is
   * read against somebody's photograph. It is the amount, not the material: at zero
   * the Liquid Glass theme still has a vibrancy view under it, and nothing gets
   * through.
   */
  glassTransparency: 45,
  staleAfterDays: THRESHOLDS.stillAfterDays,
  horizonDays: 21,
  sidebarWidth: PANELS.sidebar.default,
  assistantWidth: PANELS.assistant.default,
  meetingWidth: PANELS.meeting.default
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
    appVersion: app.getVersion(),
    activeWorkspaceId,
    onboardedAt: stored.onboardedAt ?? '',
    theme: (stored.theme as Settings['theme']) ?? DEFAULTS.theme,
    // Clamped on the way out rather than on the way in: a number that predates the
    // slider, or one typed into the database by hand, still has to draw something.
    glassTransparency: Math.min(100, Math.max(0, num('glassTransparency', DEFAULTS.glassTransparency))),
    staleAfterDays: num('staleAfterDays', DEFAULTS.staleAfterDays),
    horizonDays: num('horizonDays', DEFAULTS.horizonDays),
    sidebarWidth: num('sidebarWidth', DEFAULTS.sidebarWidth),
    assistantWidth: num('assistantWidth', DEFAULTS.assistantWidth),
    meetingWidth: num('meetingWidth', DEFAULTS.meetingWidth),
    // On by default: a meeting recording that catches only your half of the call is
    // the failure this feature exists to avoid, so it tries, and says when it cannot.
    captureSystemAudio: (stored.captureSystemAudio ?? 'true') !== 'false',
    systemAudioDevice: stored.systemAudioDevice ?? ''
  }
}

const TABLES = [
  'workspace', 'project_folder', 'project', 'person', 'membership',
  'task', 'note', 'decision', 'link', 'journal_entry', 'activity',
  // A transcript is writing, and the export is what survives this app. The audio is
  // not in here — it is a file in the data folder, which is already the backup.
  'recording', 'recording_segment', 'transcript_cue'
] as const

export function registerSettingsHandlers(): void {
  handle('settings:get', readSettings)

  handle('settings:save', async (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'dataDir' || key === 'markdownDir' || key === 'appVersion') continue
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
    // The audio goes with the rows. It is the one thing this app owns that lives
    // outside the database, so it is the one thing a wipe has to be told about.
    await rm(recordingDir(), { recursive: true, force: true })
    for (const table of [...TABLES, 'summary_part']) {
      await exec(`DROP TABLE IF EXISTS ${table} CASCADE`)
    }
    await exec('DROP TABLE IF EXISTS setting CASCADE')
    await db().exec(DDL)
    for (const statement of MIGRATIONS) await db().query(statement)
  })

  /*
   * The theme's other half, and the half that can fail. It is a channel rather than
   * something `settings:save` does on the way past because what comes back is not the
   * setting: it is what this machine could actually give, which the screen has to say
   * out loud.
   */
  handle('window:glass', ({ on }) => ({ material: setGlass(on) }))

  handle('shell:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
