import type { Decision, JournalEntry, Link, Note } from '@shared/types'
import { exec, today } from '../db/client'
import { mapDecision, mapJournal, mapLink, mapNote } from '../db/map'
import { logActivity } from '../lib/activity'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerContentHandlers(): void {
  handle('note:save', async (draft) => {
    const isNew = !draft.id
    const row = await upsert<any>(
      'note',
      pick(draft as Partial<Note>, ['projectId', 'title', 'body', 'isPinned']),
      draft.id,
      'updated_at = now()'
    )
    const note = mapNote(row)
    await logActivity(note.projectId, 'note', `${isNew ? 'Note' : 'Note updated'}: ${note.title || 'Untitled'}`)
    await mirrorProject(note.projectId)
    return note
  })

  handle('note:delete', async ({ id }) => {
    await exec('DELETE FROM note WHERE id = $1', [id])
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
    await exec('DELETE FROM decision WHERE id = $1', [id])
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
    await exec('DELETE FROM link WHERE id = $1', [id])
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
    await exec('DELETE FROM journal_entry WHERE id = $1', [id])
  })
}
