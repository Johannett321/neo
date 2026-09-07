import { q } from '../db/client'
import { remove } from '../ipc/util'
import { deleteAttachment } from './attachments'

/**
 * What a note's Markdown refers to a picture by. Stable for the life of the file,
 * because the filename is a uuid assigned once; served by `recording/media.ts`.
 */
export const imageUrl = (filename: string): string => `neo-media://image/${encodeURIComponent(filename)}`

/** The filename behind an image URL of ours, or null for any other URL. */
export function imageFile(url: string): string | null {
  const m = /^neo-media:\/\/image\/([^/?#]+)$/.exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * The sweep for pictures, run at launch beside the ones for icons and audio.
 *
 * Nothing in the database points at a `note_image` row — the note's own Markdown
 * does, by filename — so a picture deleted out of a note, or one dropped into a
 * note that was then abandoned, is a row and a file nothing refers to. The rows
 * are the reconciler's account of what to upload, so an unreferenced one is worth
 * removing rather than paying to sync.
 *
 * A day's grace, because references arrive by sync in their own time: a row can
 * land from the other Mac before the note that mentions it does, and sweeping it in
 * that gap would lose the picture on both machines.
 */
export async function pruneNoteImages(): Promise<number> {
  const rows = await q<{ id: string; path: string }>(
    `SELECT i.id, i.path FROM note_image i
      WHERE i.created_at < now() - interval '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM note n WHERE n.project_id = i.project_id AND position(i.path IN n.body) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM meeting m WHERE m.project_id = i.project_id AND position(i.path IN m.body) > 0)`
  )
  for (const row of rows) {
    await remove('note_image', row.id)
    await deleteAttachment(row.path)
  }
  return rows.length
}
