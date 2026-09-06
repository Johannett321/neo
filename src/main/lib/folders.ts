import type { ContentFolderView, ContentKind } from '@shared/types'
import { q, q1 } from '../db/client'
import { mapContentFolderView } from '../db/map'

/**
 * Filing notes and meetings.
 *
 * The project-scoped twin of the folders on the projects page, and everything true of
 * those is true here: a folder holds no work of its own, nothing in the app derives
 * anything from it, and deleting one lifts what is inside up a level rather than
 * taking it along. That is the whole licence for it being the one piece of
 * organisation the user maintains by hand.
 *
 * It lives in `lib/` rather than in a handler because two domains need it — a note is
 * saved in `ipc/content.ts` and a meeting in `ipc/meetings.ts` — and a second copy of
 * the fencing is a second copy that can drift.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * How far down a folder tree anything will walk.
 *
 * Not a rule about how you are allowed to file — nobody nests twenty deep — but a
 * floor under every recursive query. A parent pointing at its own descendant is
 * impossible through the save handlers, and a database that has been through a repair
 * is still allowed to be wrong; a walk that meets a loop must stop rather than hang the
 * process that owns the window.
 */
export const MAX_FOLDER_DEPTH = 20

/** The two lists that have folders, and the only values `kind` may take. */
const KINDS: ContentKind[] = ['note', 'meeting']

export const isContentKind = (value: unknown): value is ContentKind =>
  KINDS.includes(value as ContentKind)

/**
 * Every folder in a project, both lists at once, depth-first in the order the pages
 * draw them and each carrying its path and how much is filed directly in it.
 *
 * One statement for both kinds because a folder's kind never changes down a branch:
 * the roots are simply every parentless folder, and each row carries the list it
 * belongs to. `sort_key` is what makes it depth-first — each level appends its own
 * (position, name) to its parent's, so sorting the flat result by that array is the
 * same walk as recursing into each folder in turn. The position is padded so it sorts
 * as a number would: "10" after "9", not before it.
 */
export async function contentFolderTree(projectId: string): Promise<ContentFolderView[]> {
  const rows = await q<any>(
    `WITH RECURSIVE tree AS (
       SELECT f.*, ARRAY[f.name] AS path, 0 AS depth,
              ARRAY[lpad(f.sort_order::text, 6, '0') || ' ' || lower(f.name)] AS sort_key
       FROM content_folder f
       WHERE f.project_id = $1 AND f.parent_id IS NULL
       UNION ALL
       SELECT f.*, tree.path || f.name, tree.depth + 1,
              tree.sort_key || (lpad(f.sort_order::text, 6, '0') || ' ' || lower(f.name))
       FROM content_folder f
       JOIN tree ON f.parent_id = tree.id
       WHERE tree.depth < ${MAX_FOLDER_DEPTH}
     )
     SELECT tree.*,
            COALESCE(n.item_count, 0) + COALESCE(m.item_count, 0) AS item_count,
            COALESCE(s.folder_count, 0) AS folder_count
     FROM tree
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS item_count FROM note WHERE note.folder_id = tree.id
     ) n ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS item_count FROM meeting WHERE meeting.folder_id = tree.id
     ) m ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS folder_count
       FROM content_folder f WHERE f.parent_id = tree.id
     ) s ON true
     ORDER BY kind, sort_key`,
    [projectId]
  )
  return rows.map(mapContentFolderView)
}

/**
 * A folder and everything under it, the folder itself first.
 *
 * Used to stop a folder being moved inside one of its own children, which would cut
 * the whole branch off from the top of the tree — the rows would still be there, and
 * nothing would ever draw them again.
 */
export async function contentFolderBranch(id: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `WITH RECURSIVE branch AS (
       SELECT id, 0 AS depth FROM content_folder WHERE id = $1
       UNION ALL
       SELECT f.id, branch.depth + 1
       FROM content_folder f JOIN branch ON f.parent_id = branch.id
       WHERE branch.depth < ${MAX_FOLDER_DEPTH}
     )
     SELECT id FROM branch`,
    [id]
  )
  return rows.map((r) => r.id)
}

/**
 * The folder something is being filed into, checked before it is written.
 *
 * Two things have to hold, and both are boundaries rather than conventions. The folder
 * must belong to this project — a renderer sending the id of a folder in another
 * project would file the note somewhere no screen can ever show it, because every list
 * that draws folders is fenced to one project. And it must be a folder of the same
 * kind: notes and meetings are separate trees, and a note in a meeting's folder would
 * be filed on a page that never draws notes. Null is always allowed — that is unfiling.
 */
export async function checkContentFolder(
  folderId: unknown,
  projectId: string,
  kind: ContentKind
): Promise<void> {
  if (folderId === null || folderId === undefined) return
  const folder = await q1<any>('SELECT project_id, kind FROM content_folder WHERE id = $1', [folderId])
  if (!folder) throw new Error('That folder no longer exists.')
  if (folder.project_id !== projectId) {
    throw new Error('That folder belongs to another project.')
  }
  if (folder.kind !== kind) {
    throw new Error('Notes and meetings do not share folders.')
  }
}
