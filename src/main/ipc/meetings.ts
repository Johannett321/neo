import type { Meeting, MeetingTodo, MeetingView } from '@shared/types'
import { exec, q1, today } from '../db/client'
import { meetingViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { doneColumnId, firstColumnId } from '../lib/board'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, upsert } from './util'

/**
 * A meeting is a note that knows when it happened, who was in the room, and what
 * the room left owing. The attendees are real people, so the record answers "who
 * agreed to this" months later; the to-dos are rows rather than a slab of text, so
 * one of them can be lifted onto the board without being retyped.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every write returns the whole meeting: the panel it feeds shows all of it at once. */
async function meetingById(id: string): Promise<MeetingView> {
  const [meeting] = await meetingViews('m.id = $1', [id])
  if (!meeting) throw new Error('Meeting not found')
  return meeting
}

/** The meeting a to-do belongs to, and the project that meeting is filed under. */
async function ownerOf(todoId: string): Promise<{ meetingId: string; projectId: string }> {
  const row = await q1<any>(
    `SELECT mt.meeting_id, m.project_id
     FROM meeting_todo mt JOIN meeting m ON m.id = mt.meeting_id
     WHERE mt.id = $1`,
    [todoId]
  )
  if (!row) throw new Error('To-do not found')
  return { meetingId: row.meeting_id, projectId: row.project_id }
}

export function registerMeetingHandlers(): void {
  handle('meeting:save', async (draft) => {
    const fields = pick(draft as Partial<Meeting>, ['projectId', 'title', 'occurredOn', 'body'])
    if (!draft.id && !fields.occurredOn) fields.occurredOn = today()

    const row = await upsert<any>('meeting', fields, draft.id, 'updated_at = now()')

    if (draft.attendeeIds) {
      await exec('DELETE FROM meeting_attendee WHERE meeting_id = $1', [row.id])
      for (const personId of draft.attendeeIds) {
        await exec(
          `INSERT INTO meeting_attendee (meeting_id, person_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [row.id, personId]
        )
      }
    }

    const meeting = await meetingById(row.id)
    // One line per meeting per sitting: the page saves itself while it is being
    // written, and the re-entry brief wants "you wrote this up", not every keystroke.
    await logActivity(
      meeting.projectId,
      'meeting',
      `Meeting: ${meeting.title || meeting.occurredOn}`,
      meeting.id
    )
    await mirrorProject(meeting.projectId)
    return meeting
  })

  handle('meeting:delete', async ({ id }) => {
    const row = await q1<any>('SELECT project_id FROM meeting WHERE id = $1', [id])
    await exec('DELETE FROM meeting WHERE id = $1', [id])
    if (row) await mirrorProject(row.project_id)
  })

  handle('meetingTodo:save', async (draft) => {
    const fields = pick(draft as Partial<MeetingTodo>, ['meetingId', 'text', 'done', 'taskId', 'sortOrder'])

    if (!draft.id && fields.sortOrder === undefined && fields.meetingId) {
      const max = await q1<{ n: number }>(
        'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM meeting_todo WHERE meeting_id = $1',
        [fields.meetingId]
      )
      fields.sortOrder = max?.n ?? 0
    }

    const row = await upsert<any>('meeting_todo', fields, draft.id)
    // An item that is on the board is ticked by ticking the card, so that both
    // screens agree; `done` on the row is only read while the item is still loose.
    if (fields.done !== undefined && row.task_id) {
      await exec(
        `UPDATE task
         SET status = $2,
             completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1`,
        [row.task_id, fields.done ? 'done' : 'open']
      )
    }

    const { projectId } = await ownerOf(row.id)
    await mirrorProject(projectId)
    return meetingById(row.meeting_id)
  })

  handle('meetingTodo:delete', async ({ id }) => {
    const { projectId } = await ownerOf(id)
    // The card, if there is one, stays: it is work now, and it is on the board.
    await exec('DELETE FROM meeting_todo WHERE id = $1', [id])
    await mirrorProject(projectId)
  })

  handle('meetingTodo:promote', async ({ id, columnId }) => {
    const todo = await q1<any>('SELECT * FROM meeting_todo WHERE id = $1', [id])
    if (!todo) throw new Error('To-do not found')
    const { meetingId, projectId } = await ownerOf(id)
    if (todo.task_id) return meetingById(meetingId)

    // An item already ticked arrives finished, so it lands on the finishing line
    // rather than at the start of the board with a tick already in it.
    const column =
      columnId ?? (todo.done ? await doneColumnId(projectId) : null) ?? (await firstColumnId(projectId))
    const meeting = await q1<any>('SELECT title, occurred_on FROM meeting WHERE id = $1', [meetingId])
    const max = await q1<{ n: number }>(
      'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM task WHERE project_id = $1',
      [projectId]
    )

    // The card carries where it came from, because "why is this on the board" is the
    // question you will ask about it in three weeks.
    const task = await q1<any>(
      `INSERT INTO task (project_id, title, details, column_id, status, completed_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'done' THEN now() ELSE NULL END, $6)
       RETURNING *`,
      [
        projectId,
        todo.text,
        `From ${meeting?.title || 'a meeting'} on ${meeting?.occurred_on}.`,
        column,
        todo.done ? 'done' : 'open',
        max?.n ?? 0
      ]
    )
    await exec('UPDATE meeting_todo SET task_id = $2 WHERE id = $1', [id, task.id])
    await logActivity(projectId, 'task_created', `Added: ${task.title}`)
    await mirrorProject(projectId)
    return meetingById(meetingId)
  })
}
