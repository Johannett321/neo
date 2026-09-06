import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { iconDir } from '../db/client'

/**
 * Workspace icons are copied into the data folder and referenced by filename, so
 * they travel with a backup of the folder rather than living inside the database.
 * The renderer never touches the filesystem — it receives a data URL.
 */
export const ALLOWED_ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']
export const MAX_ICON_BYTES = 2 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
}

/**
 * A banner is a photograph across the top of a screen rather than a mark beside a
 * name, so it is allowed to be bigger. It is not allowed to be unbounded: the file
 * is copied into the data folder, and the data folder is what people back up.
 */
export const MAX_BANNER_BYTES = 8 * 1024 * 1024

/** Copy a chosen image into icons/ and return the stored filename. */
export async function storeIcon(sourcePath: string, maxBytes = MAX_ICON_BYTES): Promise<string> {
  const ext = extname(sourcePath).toLowerCase()
  if (!ALLOWED_ICON_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported image type: ${ext || 'unknown'}`)
  }
  if (statSync(sourcePath).size > maxBytes) {
    throw new Error(`That image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
  }
  await mkdir(iconDir(), { recursive: true })
  const filename = `${randomUUID()}${ext}`
  await copyFile(sourcePath, join(iconDir(), filename))
  return filename
}

/**
 * Filenames are UUIDs and their contents never change, so a read can be cached for
 * the life of the process. An avatar shows up once per row it appears in — the cast
 * panel, every meeting, every project card — and this keeps that to one read each.
 */
const cache = new Map<string, string | null>()

/** Read a stored icon back as a data URL. Returns null if it has gone missing. */
/**
 * Forget one file, so the next read goes back to the disk.
 *
 * The cache holds a `null` for a file that was not there, which is right — an icon
 * belonging to another workspace should not be looked for on every render. But a
 * file that *arrives*, as one does when it is fetched from the sync server, would
 * then go on reading as absent until the app was next opened, and an avatar that
 * appears only after a restart looks exactly like one that never arrived.
 */
export function forgetIcon(filename: string): void {
  cache.delete(filename)
}

export async function readIcon(filename: string): Promise<string | null> {
  if (!filename) return null
  const hit = cache.get(filename)
  if (hit !== undefined) return hit

  const ext = extname(filename).toLowerCase()
  const mime = MIME[ext]
  if (!mime) return null
  try {
    const bytes = await readFile(join(iconDir(), filename))
    const url = `data:${mime};base64,${bytes.toString('base64')}`
    cache.set(filename, url)
    return url
  } catch {
    cache.set(filename, null)
    return null
  }
}

export async function deleteIcon(filename: string): Promise<void> {
  if (!filename) return
  cache.delete(filename)
  await rm(join(iconDir(), filename), { force: true })
}

/**
 * Icons are stored the moment they are picked, so abandoning the dialog that was
 * going to use one leaves a file nobody references. Swept on launch.
 */
export async function pruneIcons(referenced: string[]): Promise<number> {
  let removed = 0
  try {
    const keep = new Set(referenced.filter(Boolean))
    for (const file of await readdir(iconDir())) {
      if (!keep.has(file)) {
        await rm(join(iconDir(), file), { force: true })
        removed++
      }
    }
  } catch {
    // No icons directory yet — nothing to prune.
  }
  return removed
}
