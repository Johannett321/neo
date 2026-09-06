import type { ContentFolder, ContentKind, Decision, JournalEntry, Link, Note } from '@shared/types'
import { q1, today } from '../db/client'
import { mapContentFolder, mapDecision, mapJournal, mapLink, mapNote } from '../db/map'
import { logActivity } from '../lib/activity'
import {
  checkContentFolder, contentFolderBranch, isContentKind
} from '../lib/folders'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, remove, updateWhere, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerContentHandlers(): void {
  handle('note:save', async (draft) => {
    const fields = pick(draft as Partial<Note>, ['projectId', 'title', 'body', 'folderId', 'isPinned'])

    if (fields.folderId !== undefined) {
      const current = draft.id
        ? await q1<any>('SELECT project_id FROM note WHERE id = $1', [draft.id])
        : null
      const projectId = String((fields.projectId as string | undefined) ?? current?.project_id ?? '')
      await checkContentFolder(fields.folderId, projectId, 'note')
    }

    const row = await upsert<any>('note', fields, draft.id, 'updated_at = now()')
    const note = mapNote(row)
    // One line per note per sitting: the writer saves itself continuously, and the
    // re-entry brief wants "you wrote this note", not a stopwatch of every keystroke.
    await logActivity(note.projectId, 'note', `Note: ${note.title || 'Untitled'}`, note.id)
    await mirrorProject(note.projectId)
    return note
  })

  handle('note:delete', async ({ id }) => {
    await remove('note', id)
  })

  /*
   * ------------------------------------------------- filing notes and meetings
   *
   * Both lists, through one `kind`. These live here rather than beside the meeting
   * handlers because they are one feature serving two screens, and a second copy of
   * any of it is a second copy that can drift.
   *
   * A folder holds no work of its own, so none of this logs activity: "you made a
   * folder" is not something a re-entry brief has any business saying. What does have
   * to happen is the mirror — a folder is a real directory under `notes/` or
   * `meetings/` on disk, so its name and its parent are both part of where the writing
   * inside it is written.
   */

  handle('contentFolder:save', async (draft) => {
    const fields = pick(draft as Partial<ContentFolder>, [
      'projectId', 'kind', 'parentId', 'name', 'sortOrder'
    ])
    if (fields.name !== undefined) {
      const name = String(fields.name).trim()
      if (!name) throw new Error('A folder needs a name.')
      fields.name = name
    }

    const existing = draft.id
      ? await q1<any>('SELECT * FROM content_folder WHERE id = $1', [draft.id])
      : null
    if (draft.id && !existing) throw new Error('That folder no longer exists.')

    const projectId = (fields.projectId as string | undefined) ?? existing?.project_id
    if (!projectId) throw new Error('A folder belongs to a project.')
    const kind = ((fields.kind as ContentKind | undefined) ?? existing?.kind) as ContentKind
    if (!isContentKind(kind)) throw new Error('A folder holds notes or meetings.')

    /*
     * Neither the project nor the list a folder was made in ever changes. Both would
     * strand what is filed inside it: the notes would still point at it and no screen
     * on earth would draw them, since every list of folders is fenced to one project
     * and one kind. Moving the writing is what moving the writing is for.
     */
    if (existing) {
      if (fields.projectId !== undefined && fields.projectId !== existing.project_id) {
        throw new Error('A folder stays in the project it was made in.')
      }
      if (fields.kind !== undefined && fields.kind !== existing.kind) {
        throw new Error('A folder stays in the list it was made in.')
      }
    }

    if (fields.parentId) {
      const parent = await q1<any>(
        'SELECT project_id, kind FROM content_folder WHERE id = $1',
        [fields.parentId]
      )
      if (!parent) throw new Error('That folder no longer exists.')
      if (parent.project_id !== projectId) {
        throw new Error('A folder cannot be moved into another project.')
      }
      if (parent.kind !== kind) throw new Error('Notes and meetings do not share folders.')
      // Into itself, or into anything filed inside it: the branch would still exist
      // and nothing would ever draw it again.
      if (draft.id && (await contentFolderBranch(draft.id)).includes(String(fields.parentId))) {
        throw new Error('A folder cannot be moved inside itself.')
      }
    }

    // New folders go to the end of the level they are created in.
    if (!draft.id && fields.sortOrder === undefined) {
      const max = await q1<{ n: number }>(
        `SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM content_folder
         WHERE project_id = $1 AND kind = $2 AND parent_id IS NOT DISTINCT FROM $3`,
        [projectId, kind, fields.parentId ?? null]
      )
      fields.sortOrder = max?.n ?? 0
    }

    const folder = mapContentFolder(await upsert<any>('content_folder', fields, draft.id))
    // A folder's name is part of the path everything in it is mirrored to.
    await mirrorProject(folder.projectId)
    return folder
  })

  handle('contentFolder:delete', async ({ id }) => {
    const folder = await q1<any>(
      'SELECT project_id, parent_id FROM content_folder WHERE id = $1',
      [id]
    )
    if (!folder) return
    /*
     * Everything inside comes up a level first, so deleting a folder is only ever
     * undoing the filing — never losing a note, a meeting, or a whole branch of them.
     * That is also why nothing asks before it runs: there is nothing to warn about.
     *
     * Both tables are swept rather than the one matching the folder's kind. Only rows
     * of the right kind can be pointing at it — that is what `checkContentFolder`
     * guarantees on every write — so the other statement matches nothing, and two
     * plain statements beat a table name pasted into the SQL.
     */
    await updateWhere('note', { folderId: id }, { folderId: folder.parent_id })
    await updateWhere('meeting', { folderId: id }, { folderId: folder.parent_id })
    await updateWhere('content_folder', { parentId: id }, { parentId: folder.parent_id })
    await remove('content_folder', id)
    await mirrorProject(folder.project_id)
  })

  handle('decision:save', async (draft) => {
    const fields = pick(draft as Partial<Decision>, [
      'projectId', 'title', 'rationale', 'alternatives', 'decidedBy', 'decidedOn'
    ])
    if (!draft.id && !fields.decidedOn) fields.decidedOn = today()
    const row = await upsert<any>('decision', fields, draft.id)
    const decision = mapDecision(row)
    await logActivity(decision.projectId, 'decision', `Decision: ${decision.title}`)
    await mirrorProject(decision.projectId)
    return decision
  })

  handle('decision:delete', async ({ id }) => {
    await remove('decision', id)
  })

  handle('link:save', async (draft) => {
    const isNew = !draft.id
    const row = await upsert<any>(
      'link',
      pick(draft as Partial<Link>, ['projectId', 'label', 'url', 'kind', 'sortOrder']),
      draft.id
    )
    const link = mapLink(row)
    if (isNew) await logActivity(link.projectId, 'link_added', `Link added: ${link.label}`)
    await mirrorProject(link.projectId)
    return link
  })

  handle('link:delete', async ({ id }) => {
    await remove('link', id)
  })

  handle('journal:save', async (draft) => {
    const fields = pick(draft as Partial<JournalEntry>, ['projectId', 'body', 'occurredOn'])
    if (!draft.id && !fields.occurredOn) fields.occurredOn = today()
    const row = await upsert<any>('journal_entry', fields, draft.id)
    const entry = mapJournal(row)
    await logActivity(entry.projectId, 'journal', entry.body.slice(0, 120))
    await mirrorProject(entry.projectId)
    return entry
  })

  handle('journal:delete', async ({ id }) => {
    await remove('journal_entry', id)
  })
}
