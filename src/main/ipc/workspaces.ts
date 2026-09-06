import { dialog } from 'electron'
import type { Workspace, WorkspaceLink } from '@shared/types'
import { q, q1 } from '../db/client'
import { mapWorkspace, mapWorkspaceLink } from '../db/map'
import { ALLOWED_ICON_EXTENSIONS, MAX_BANNER_BYTES, deleteIcon, readIcon, storeIcon } from '../lib/icons'
import { bannerUrl } from '../lib/recording/media'
import { forgetWeather } from '../lib/weather'
import { pruneRecordings } from '../lib/recording/store'
import { ensureMe } from '../lib/profile'
import { handle, pick, remove, reorder, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
const withIcon = async (row: any): Promise<Workspace> =>
  mapWorkspace(row, await readIcon(row.icon_path ?? ''))

export function registerWorkspaceHandlers(): void {
  handle('workspace:list', async () => {
    const rows = await q<any>('SELECT * FROM workspace ORDER BY sort_order, name')
    return Promise.all(rows.map(withIcon))
  })

  handle('workspace:save', async (draft) => {
    const fields = pick(draft as Partial<Workspace>, [
      'name', 'color', 'iconPath', 'sortOrder', 'aiModel',
      // Recording settings. Still an explicit allowlist: `ai_api_key` is not on it,
      // and cannot reach a column through this channel however it is spelled.
      'transcribeEngine', 'transcribeModel', 'transcribeBaseUrl', 'transcribeLanguage',
      'recapEngine', 'recapModel', 'recapBaseUrl', 'recapPrompt',
      // What the Today page looks like. Furniture, all of it: nothing here is read by
      // attention, by the mirror or by anything that decides what you should do next.
      'bannerPath', 'bannerX', 'bannerY', 'bio', 'weatherPlace', 'weatherLatitude', 'weatherLongitude',
      'todayShowClock', 'todayShowWeather', 'todayShowBio', 'todayShowLinks', 'todayShowStats',
      'todayShowAttention', 'todayShowMeetingTodos', 'todayShowSoon',
      // What this working life may say out loud. Not furniture — these decide whether
      // something interrupts you — but still nothing that anything derives from: the
      // deadlines they read are the same ones Today reads, and forgetting to set one
      // costs you a nudge, never an answer.
      'notify', 'notifyProjectAheadDays', 'notifyProjectOnTheDay',
      'notifyTaskAheadDays', 'notifyTaskOnTheDay', 'notifyTaskDayAfter'
    ])

    // Where the banner sits is a percentage, and a percentage outside 0-100 draws a
    // strip of nothing. Clamped here rather than trusted from the renderer, for the
    // same reason the column list is an allowlist.
    for (const axis of ['bannerX', 'bannerY'] as const) {
      if (fields[axis] !== undefined) {
        fields[axis] = Math.min(100, Math.max(0, Math.round(Number(fields[axis]) || 0)))
      }
    }

    // How many days ahead you are warned, clamped where it is written rather than
    // trusted. Zero means never, and the top is a quarter — a warning further out
    // than that is not a warning, it is a second copy of the deadline.
    for (const days of ['notifyProjectAheadDays', 'notifyTaskAheadDays'] as const) {
      if (fields[days] !== undefined) {
        fields[days] = Math.min(90, Math.max(0, Math.round(Number(fields[days]) || 0)))
      }
    }

    if (!draft.id && fields.sortOrder === undefined) {
      const max = await q1<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM workspace')
      fields.sortOrder = max?.n ?? 0
    }

    // Replacing or removing an image should not leave the old file behind. The banner
    // lives in the same folder as the icons and is swept by the same broom.
    const orphans: string[] = []
    if (draft.id && (fields.iconPath !== undefined || fields.bannerPath !== undefined)) {
      const current = await q1<any>(
        'SELECT icon_path, banner_path FROM workspace WHERE id = $1',
        [draft.id]
      )
      if (fields.iconPath !== undefined && current?.icon_path && current.icon_path !== fields.iconPath) {
        orphans.push(current.icon_path)
      }
      if (
        fields.bannerPath !== undefined &&
        current?.banner_path &&
        current.banner_path !== fields.bannerPath
      ) {
        orphans.push(current.banner_path)
      }
    }

    // A changed place has to be read again now rather than in a quarter of an hour,
    // or the pane you just typed it into goes on showing the old town's weather.
    if (fields.weatherPlace !== undefined) forgetWeather()

    const row = await upsert<any>('workspace', fields, draft.id)
    for (const orphan of orphans) await deleteIcon(orphan)
    await ensureMe(row.id)
    return withIcon(row)
  })

  handle('workspace:delete', async ({ id }) => {
    const row = await q1<any>('SELECT icon_path, banner_path FROM workspace WHERE id = $1', [id])
    await remove('workspace', id)
    if (row?.icon_path) await deleteIcon(row.icon_path)
    if (row?.banner_path) await deleteIcon(row.banner_path)
    // Every project, meeting and recording inside it has gone; the audio has not.
    await pruneRecordings()
  })

  handle('workspace:setArchived', async ({ id, archived }) => {
    const row = await upsert<any>('workspace', { archivedAt: archived ? new Date() : null }, id)
    if (!row) throw new Error('Workspace not found')
    return withIcon(row)
  })

  handle('workspace:reorder', async ({ ids }) => {
    await reorder('workspace', ids)
  })

  handle('icon:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a workspace icon',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ALLOWED_ICON_EXTENSIONS.map((e) => e.slice(1)) }]
    })
    const source = result.filePaths[0]
    if (result.canceled || !source) return null

    const iconPath = await storeIcon(source)
    const dataUrl = await readIcon(iconPath)
    return dataUrl ? { iconPath, dataUrl } : null
  })

  handle('banner:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a banner for this workspace',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ALLOWED_ICON_EXTENSIONS.map((e) => e.slice(1)) }]
    })
    const source = result.filePaths[0]
    if (result.canceled || !source) return null

    // Stored the moment it is picked, exactly as an icon is, and swept at launch if
    // the dialog that was going to use it is abandoned.
    const bannerPath = await storeIcon(source, MAX_BANNER_BYTES)
    return { bannerPath, url: bannerUrl(bannerPath) }
  })

  /* ------------------------------------------------- the workspace's own links */

  handle('workspaceLink:list', async ({ workspaceId }) => {
    const rows = await q<any>(
      'SELECT * FROM workspace_link WHERE workspace_id = $1 ORDER BY sort_order, created_at',
      [workspaceId]
    )
    return rows.map(mapWorkspaceLink)
  })

  handle('workspaceLink:save', async (draft) => {
    const fields = pick(draft as Partial<WorkspaceLink>, ['workspaceId', 'label', 'url', 'sortOrder'])
    if (typeof fields.url === 'string') fields.url = normaliseUrl(fields.url)
    // Refused on the way in, on a new link and on an edit alike: a link with no
    // address draws a chip on the front page that does nothing when you press it.
    if ((fields.url !== undefined || !draft.id) && !fields.url) {
      throw new Error('A link needs an address.')
    }

    if (!draft.id) {
      if (!fields.workspaceId) throw new Error('A link belongs to a workspace.')
      if (fields.sortOrder === undefined) {
        const max = await q1<{ n: number }>(
          'SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM workspace_link WHERE workspace_id = $1',
          [fields.workspaceId]
        )
        fields.sortOrder = max?.n ?? 1
      }
      // A link with no label is drawn by its host, which is what you would have
      // typed anyway. Nothing is stored blank that can be worked out.
      if (!fields.label) fields.label = hostOf(String(fields.url))
    }
    return mapWorkspaceLink(await upsert<any>('workspace_link', fields, draft.id))
  })

  handle('workspaceLink:delete', async ({ id }) => {
    await remove('workspace_link', id)
  })

  handle('workspaceLink:reorder', async ({ ids }) => {
    await reorder('workspace_link', ids)
  })
}

/**
 * What someone types is `intranet.company.com`, and what a browser needs is a scheme.
 * Anything already carrying one is left exactly as it was typed, so a `mailto:` or an
 * internal `http://` box is not quietly rewritten into something else.
 */
function normaliseUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The bit of an address a person would recognise, for a link that was given no label. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
