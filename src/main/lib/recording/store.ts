import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, q } from '../../db/client'

/**
 * Where the audio lives.
 *
 * One folder per recording, one file per segment, inside `~/.neo` with
 * everything else — so a backup of that folder is a backup of the meetings too, and
 * a recording can be dragged out and played in anything.
 *
 * Every write is an append that is flushed before it is acknowledged. That is the
 * whole durability story and it is deliberately this dumb: there is no buffer in
 * this process holding audio that the disk does not have, so the worst a power cut
 * can cost is the second that was in flight. Nothing here ever rewrites a file, so
 * a process that dies mid-write leaves a shorter file, never a corrupt one.
 */

export const recordingDir = (): string => join(dataRoot(), 'recordings')

const dirFor = (recordingId: string): string => join(recordingDir(), recordingId)

/** The path a segment's bytes go to, relative to its recording's folder. */
export const segmentFile = (ord: number, extension = 'webm'): string =>
  `${String(ord).padStart(4, '0')}.${extension}`

export const segmentPath = (recordingId: string, file: string): string =>
  join(dirFor(recordingId), file)

/** Create the folder and the empty file, so the segment exists before any audio does. */
export async function openSegmentFile(recordingId: string, file: string): Promise<void> {
  await mkdir(dirFor(recordingId), { recursive: true })
  await writeFile(segmentPath(recordingId, file), Buffer.alloc(0), { flag: 'a' })
}

/**
 * Append one chunk and report the file's size afterwards.
 *
 * `appendFile` opens, writes and closes, which is what makes the bytes survive the
 * process going away without a flush of our own. It is a syscall a second on a file
 * of a few megabytes; the cost is not measurable and the guarantee is worth far more.
 */
export async function appendChunk(
  recordingId: string,
  file: string,
  data: Buffer
): Promise<number> {
  const path = segmentPath(recordingId, file)
  await appendFile(path, data)
  return (await stat(path)).size
}

export async function segmentBytes(recordingId: string, file: string): Promise<number> {
  try {
    return (await stat(segmentPath(recordingId, file))).size
  } catch {
    return 0
  }
}

export async function readSegmentStream(
  recordingId: string,
  file: string,
  start?: number,
  end?: number
): Promise<{ stream: NodeJS.ReadableStream; size: number }> {
  const path = segmentPath(recordingId, file)
  const size = (await stat(path)).size
  return { stream: createReadStream(path, { start, end }), size }
}

/** Take the audio away and leave the words. Removing the folder removes all of it. */
export async function deleteAudio(recordingId: string): Promise<void> {
  await rm(dirFor(recordingId), { recursive: true, force: true })
}

/**
 * Audio whose recording is gone.
 *
 * Deleting a meeting, a project or a workspace takes the `recording` row with it
 * through the foreign keys — but a cascade knows nothing about the filesystem, and
 * an hour of a meeting is the largest thing this app ever writes. So the folders are
 * swept against the rows that are actually left, the same way `pruneIcons()` sweeps
 * the images. Run after anything that can delete a recording, and again at launch as
 * the backstop for whatever managed not to.
 *
 * Deliberately keyed on the rows rather than on a list passed in: the question is
 * always "which folders have no row", and asking the database is the only answer
 * that cannot go stale.
 */
export async function pruneRecordings(): Promise<number> {
  let folders: string[]
  try {
    folders = await readdir(recordingDir())
  } catch {
    return 0 // Nothing has ever been recorded.
  }

  const live = new Set((await q<{ id: string }>('SELECT id FROM recording')).map((r) => r.id))
  let removed = 0
  for (const folder of folders) {
    if (live.has(folder)) continue
    await rm(join(recordingDir(), folder), { recursive: true, force: true })
    removed++
  }
  return removed
}
