import { dialog } from 'electron'
import type { Workspace } from '@shared/types'
import { exec, q, q1 } from '../db/client'
import { mapWorkspace } from '../db/map'
import { ALLOWED_ICON_EXTENSIONS, deleteIcon, readIcon, storeIcon } from '../lib/icons'
import { ensureMe } from '../lib/profile'
import { handle, pick, reorder, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
const withIcon = async (row: any): Promise<Workspace> =>
  mapWorkspace(row, await readIcon(row.icon_path ?? ''))

export function registerWorkspaceHandlers(): void {
  handle('workspace:list', async () => {
    const rows = await q<any>('SELECT * FROM workspace ORDER BY sort_order, name')
    return Promise.all(rows.map(withIcon))
  })

  handle('workspace:save', async (draft) => {
    const fields = pick(draft as Partial<Workspace>, ['name', 'color', 'iconPath', 'sortOrder'])

    if (!draft.id && fields.sortOrder === undefined) {
      const max = await q1<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM workspace')
      fields.sortOrder = max?.n ?? 0
    }

    // Replacing or removing an icon should not leave the old file behind.
    let orphan = ''
    if (draft.id && fields.iconPath !== undefined) {
      const current = await q1<any>('SELECT icon_path FROM workspace WHERE id = $1', [draft.id])
      if (current?.icon_path && current.icon_path !== fields.iconPath) orphan = current.icon_path
    }

    const row = await upsert<any>('workspace', fields, draft.id)
    if (orphan) await deleteIcon(orphan)
    await ensureMe(row.id)
    return withIcon(row)
  })

  handle('workspace:delete', async ({ id }) => {
    const row = await q1<any>('SELECT icon_path FROM workspace WHERE id = $1', [id])
    await exec('DELETE FROM workspace WHERE id = $1', [id])
    if (row?.icon_path) await deleteIcon(row.icon_path)
  })

  handle('workspace:setArchived', async ({ id, archived }) => {
    const row = await q1<any>(
      `UPDATE workspace SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE id = $1 RETURNING *`,
      [id]
    )
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
}
