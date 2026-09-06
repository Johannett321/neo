import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { ChangelogEntry } from '@shared/update'
import { changelogVersion, compareVersions, parseChangelog } from './update'

/**
 * What changed, as it ships with the app.
 *
 * The changelog is a folder of Markdown files in the repository — one per released
 * version, with its illustrations beside it — bundled into the application and read
 * from disk. Not fetched, and deliberately: the screen that says what changed appears
 * the first time you open a version you have just updated to, which is exactly the
 * moment a laptop is most likely to be on a train with no network. A release note
 * that cannot be read offline is a release note nobody reads.
 *
 * It is also the single description of a release. The notes on the GitHub release are
 * generated from these same files when the tag is pushed, so the sentence somebody
 * reads before updating and the sentence they read afterwards are the same sentence.
 */

/**
 * Where the folder is in this copy of the app.
 *
 * Which file exists, never `app.isPackaged` — dev-branding renames the executable, so
 * a development run reports itself as packaged and would look in the wrong place.
 * The same trap the Claude connector and the audio helper both document.
 */
export function changelogDir(): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'changelog') : '',
    join(app.getAppPath(), 'changelog'),
    // The app path inside a packed build is the asar itself; the repository root is
    // one level up from it in development runs that start from `out/`.
    join(app.getAppPath(), '..', 'changelog')
  ]
  return candidates.find((path) => path && existsSync(path)) ?? ''
}

/** One version's entry, or null when that release did not write one. */
export async function readChangelog(version: string): Promise<ChangelogEntry | null> {
  const dir = changelogDir()
  if (!dir || !changelogVersion(`${version}.md`)) return null
  try {
    return parseChangelog(version, await readFile(join(dir, `${version}.md`), 'utf8'))
  } catch {
    return null
  }
}

/** Every entry that shipped, newest first. Empty is a perfectly good answer. */
export async function listChangelog(limit = 20): Promise<ChangelogEntry[]> {
  const dir = changelogDir()
  if (!dir) return []
  try {
    const versions = (await readdir(dir))
      .map(changelogVersion)
      .filter(Boolean)
      .sort((a, b) => compareVersions(b, a))
      .slice(0, limit)
    const entries = await Promise.all(versions.map((v) => readChangelog(v)))
    return entries.filter((e): e is ChangelogEntry => e !== null)
  } catch {
    return []
  }
}

const MEDIA = /\.(png|jpg|jpeg|webp|gif|svg)$/i

/**
 * The absolute path of an illustration a changelog asks for, or empty.
 *
 * The renderer only ever names a file relative to the changelog folder, and the
 * answer is resolved and then checked to still be inside it — so `../../` in a URL
 * typed by hand reaches nothing. It is the same shape of guard the banner has, with
 * the folder standing in for the database: what makes a file servable is that it is
 * one of the app's own, not that its name looks right.
 */
export function changelogMedia(relative: string): string {
  const dir = changelogDir()
  if (!dir || !MEDIA.test(relative)) return ''
  const root = resolve(dir)
  const path = resolve(root, relative)
  if (path !== root && !path.startsWith(root + sep)) return ''
  return existsSync(path) ? path : ''
}
