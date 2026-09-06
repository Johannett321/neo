import type { Meeting, MeetingTodo, MeetingView } from '@shared/types'
import { exec, q, q1, today } from '../db/client'
import { meetingViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { doneColumnId, firstColumnId } from '../lib/board'
import { checkContentFolder } from '../lib/folders'
import { mirrorProject } from '../lib/markdown'
import { describeEngineError, recapEngine, workspaceOfMeeting } from '../lib/recording/engine'
import { pruneRecordings } from '../lib/recording/store'
import { suggestTitle } from '../lib/recording/summarise'
import { handle, pick, remove, upsert } from './util'

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
    const fields = pick(draft as Partial<Meeting>, [
      'projectId', 'title', 'occurredOn', 'body', 'folderId'
    ])
    if (!draft.id && !fields.occurredOn) fields.occurredOn = today()

    // Filing is fenced the same way a note's is, and by the same code: the folder has
    // to belong to this project and to the meetings list rather than the notes one.
    if (fields.folderId !== undefined) {
      const current = draft.id
        ? await q1<any>('SELECT project_id FROM meeting WHERE id = $1', [draft.id])
        : null
      const projectId = String((fields.projectId as string | undefined) ?? current?.project_id ?? '')
      await checkContentFolder(fields.folderId, projectId, 'meeting')
    }

    const row = await upsert<any>('meeting', fields, draft.id, 'updated_at = now()')

    if (draft.attendeeIds) {
      /*
       * Diffed rather than replaced wholesale. The page saves itself while it is
       * being written, and delete-everything-then-reinsert would put the same
       * attendees into the log on every keystroke that autosaves.
       */
      const wanted = new Set(draft.attendeeIds)
      const current = await q<{ id: string; person_id: string }>(
        'SELECT id, person_id FROM meeting_attendee WHERE meeting_id = $1',
        [row.id]
      )
      for (const attendee of current) {
        if (!wanted.has(attendee.person_id)) await remove('meeting_attendee', attendee.id)
      }
      const have = new Set(current.map((a) => a.person_id))
      for (const personId of wanted) {
        if (!have.has(personId)) await upsert('meeting_attendee', { meetingId: row.id, personId })
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

  /**
   * Naming a meeting for you.
   *
   * A suggestion and nothing more: it writes no row. The name goes back to the page,
   * lands in the field, and is saved by the same autosave that keeps everything else
   * on that page — so it can be read, edited or simply typed over before it sticks,
   * which is what you want from something a model came up with.
   *
   * It reads whatever the meeting actually has. A transcript if there is one, because
   * that is the meeting itself; the write-up otherwise. Enough of either to name it
   * by, and no more — the first several thousand words settle what a meeting was
   * about, and sending an hour of talk to name six words of it is waste.
   */
  handle('meeting:suggestName', async ({ id }) => {
    const meeting = await q1<any>(
      `SELECT m.*, p.name AS project_name FROM meeting m
       JOIN project p ON p.id = m.project_id WHERE m.id = $1`,
      [id]
    )
    if (!meeting) throw new Error('That meeting is no longer here.')

    const spoken = await q<{ speaker: string; text: string }>(
      `SELECT c.speaker, c.text FROM transcript_cue c
       JOIN recording r ON r.id = c.recording_id
       WHERE r.meeting_id = $1 ORDER BY c.ord LIMIT 400`,
      [id]
    )
    const written = (meeting.body ?? '').trim()
    const content = [
      written ? `The write-up:\n\n${written}` : '',
      spoken.length ? `What was said:\n\n${spoken.map((c) => c.text).join(' ')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 24_000)

    if (!content) {
      throw new Error('There is nothing in this meeting to name it from yet — write something first, or record it.')
    }

    const attendees = await q<{ name: string }>(
      `SELECT pe.name FROM meeting_attendee ma JOIN person pe ON pe.id = ma.person_id
       WHERE ma.meeting_id = $1 ORDER BY pe.name`,
      [id]
    )

    const config = recapEngine(await workspaceOfMeeting(id))
    try {
      const title = await suggestTitle(
        config,
        {
          occurredOn: meeting.occurred_on,
          projectName: meeting.project_name,
          attendees: attendees.map((a) => a.name)
        },
        content
      )
      if (!title) throw new Error('The model did not come back with a name.')
      return { title }
    } catch (error) {
      throw new Error(describeEngineError(error, config))
    }
  })

  handle('meeting:delete', async ({ id }) => {
    const row = await q1<any>('SELECT project_id FROM meeting WHERE id = $1', [id])
    await remove('meeting', id)
    // The recording row goes with the meeting through the foreign key, but its audio
    // is a folder on disk that no cascade knows about — and it is the largest thing
    // this app writes. Sweep it now rather than at the next launch.
    await pruneRecordings()
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
    await remove('meeting_todo', id)
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
    const task = await upsert<any>('task', {
      projectId,
      title: todo.text,
      details: `From ${meeting?.title || 'a meeting'} on ${meeting?.occurred_on}.`,
      columnId: column,
      status: todo.done ? 'done' : 'open',
      completedAt: todo.done ? new Date() : null,
      sortOrder: max?.n ?? 0
    })
    await upsert('meeting_todo', { taskId: task.id }, id)
    await logActivity(projectId, 'task_created', `Added: ${task.title}`)
    await mirrorProject(projectId)
    return meetingById(meetingId)
  })
}
