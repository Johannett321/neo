import { dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { api, must, upload } from '../lib/cloud/client'
import { forgetWeather } from '../lib/weather'
import { handle, withoutId } from './util'

/** Pictures a workspace, a project or a person can wear. */
const PICTURES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']

export const mediaUrl = (name: string): string => `neo-media://file/${encodeURIComponent(name)}`

/**
 * A picture chosen from the disk, sent to Neo Cloud and named by it.
 *
 * Read and sent at once, and never copied anywhere on this machine: the file stays
 * where the person keeps it, and what the row refers to is the name the server gave
 * the copy it holds. The server checks the type and the size and says so in words.
 */
export async function pickPicture(
  title: string,
  kind: 'icon' | 'banner' | 'avatar'
): Promise<{ name: string } | null> {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: PICTURES }]
  })
  const source = result.filePaths[0]
  if (result.canceled || !source) return null
  if (!PICTURES.includes(extname(source).slice(1).toLowerCase())) {
    throw new Error(`Unsupported image type: ${extname(source) || 'unknown'}`)
  }
  // Refused before it is read, so a mistaken click on a video does not load it into memory.
  const limit = kind === 'icon' ? 2 : 8
  if ((await stat(source)).size > limit * 1024 * 1024) {
    throw new Error(`That image is larger than ${limit} MB.`)
  }
  const stored = await upload<{ name: string }>('/v1/files', { kind, filename: basename(source) },
    new Uint8Array(await readFile(source)))
  return { name: stored.name }
}

export function registerWorkspaceHandlers(): void {
  handle('workspace:list', () => must(api.GET('/v1/workspaces')))

  handle('workspace:save', async (draft) => {
    // A changed place has to be read again now rather than in a quarter of an hour.
    if (draft.weatherPlace !== undefined) forgetWeather()
    return draft.id
      ? must(api.PATCH('/v1/workspaces/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/workspaces', { body: withoutId(draft) }))
  })

  handle('workspace:delete', async ({ id }) => {
    await must(api.DELETE('/v1/workspaces/{id}', { params: { path: { id } } }))
  })

  handle('workspace:setArchived', ({ id, archived }) =>
    must(api.PUT('/v1/workspaces/{id}/archived', { params: { path: { id } }, body: { archived } })))

  handle('workspace:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/workspaces/order', { body: { ids } }))
  })

  handle('icon:pick', async () => {
    const stored = await pickPicture('Choose a workspace icon', 'icon')
    return stored ? { iconPath: stored.name, dataUrl: mediaUrl(stored.name) } : null
  })

  handle('banner:pick', async () => {
    const stored = await pickPicture('Choose a banner for this workspace', 'banner')
    return stored ? { bannerPath: stored.name, url: mediaUrl(stored.name) } : null
  })

  handle('workspaceLink:list', ({ workspaceId }) =>
    must(api.GET('/v1/workspace-links', { params: { query: { workspaceId } } })))

  handle('workspaceLink:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/workspace-links/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/workspace-links', { body: withoutId(draft) })))

  handle('workspaceLink:delete', async ({ id }) => {
    await must(api.DELETE('/v1/workspace-links/{id}', { params: { path: { id } } }))
  })

  handle('workspaceLink:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/workspace-links/order', { body: { ids } }))
  })
}
