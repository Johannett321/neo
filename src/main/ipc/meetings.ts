import type { Meeting } from '@shared/types'
import { exec, q, q1, today } from '../db/client'
import { withAttendeeAvatars } from './projects'
import { logActivity } from '../lib/activity'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, upsert } from './util'

/**
 * A meeting is a note with the parts a meeting actually has: when it happened, who
 * was in the room, what was on the agenda, and what came out of it. Keeping attendees
 * as real people means the record answers "who agreed to this" months later.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const MEETING_SELECT = /* sql */ `
SELECT m.*, COALESCE(a.attendees, '[]'::json) AS attendees
FROM meeting m
LEFT JOIN LATERAL (
  SELECT json_agg(att) AS attendees FROM (
    SELECT pe.id, pe.name, pe.avatar_color AS color, pe.avatar_path, COALESCE(mem.role, '') AS role
    FROM meeting_attendee ma
    JOIN person pe ON pe.id = ma.person_id
    LEFT JOIN membership mem ON mem.person_id = pe.id AND mem.project_id = m.project_id
    WHERE ma.meeting_id = m.id
    ORDER BY pe.name
  ) att
) a ON true
WHERE m.id = $1
`

export function registerMeetingHandlers(): void {
  handle('meeting:save', async (draft) => {
    const fields = pick(draft as Partial<Meeting>, [
      'projectId', 'title', 'occurredOn', 'startsAt', 'location', 'agenda', 'body', 'actions'
    ])
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

    const joined = await q<any>(MEETING_SELECT, [row.id])
    const meeting = await withAttendeeAvatars(joined[0])
    await logActivity(meeting.projectId, 'meeting', `Meeting: ${meeting.title || meeting.occurredOn}`)
    await mirrorProject(meeting.projectId)
    return meeting
  })

  handle('meeting:delete', async ({ id }) => {
    const row = await q1<any>('SELECT project_id FROM meeting WHERE id = $1', [id])
    await exec('DELETE FROM meeting WHERE id = $1', [id])
    if (row) await mirrorProject(row.project_id)
  })
}
