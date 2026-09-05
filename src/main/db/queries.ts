import type { MeetingView, ProjectSummary, RecordingView, TaskView } from '@shared/types'
import { attentionReason } from '../lib/attention'
import { readIcon } from '../lib/icons'
import { daysBetween, daysSince, q, today } from './client'
import { mapMeeting, mapProject, mapRecording, mapSegment, mapTaskView } from './map'

/** Project rows carry the aggregates every list view needs, computed in one pass. */
const PROJECT_SELECT = /* sql */ `
SELECT p.*, w.name AS workspace_name, w.color AS workspace_color,
       COALESCE(agg.open_tasks, 0)     AS open_tasks,
       COALESCE(agg.overdue_tasks, 0)  AS overdue_tasks,
       agg.next_due,
       agg.worst_overdue_date,
       COALESCE(cast_count.people_count, 0) AS people_count,
       COALESCE(mine.my_roles, '') AS my_roles,
       cast_list.cast_preview
FROM project p
JOIN workspace w ON w.id = p.workspace_id
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE t.status = 'open')::int AS open_tasks,
    count(*) FILTER (WHERE t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < $1)::int AS overdue_tasks,
    min(t.due_date) FILTER (WHERE t.status = 'open' AND t.due_date IS NOT NULL) AS next_due,
    min(t.due_date) FILTER (WHERE t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < $1) AS worst_overdue_date
  FROM task t WHERE t.project_id = p.id
) agg ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS people_count FROM membership m WHERE m.project_id = p.id
) cast_count ON true
LEFT JOIN LATERAL (
  SELECT m.role AS my_roles
  FROM membership m JOIN person pe ON pe.id = m.person_id
  WHERE m.project_id = p.id AND pe.is_me
  LIMIT 1
) mine ON true
LEFT JOIN LATERAL (
  SELECT json_agg(preview) AS cast_preview FROM (
    SELECT pe.name, pe.avatar_color AS color, pe.avatar_path, m.role
    FROM membership m JOIN person pe ON pe.id = m.person_id
    WHERE m.project_id = p.id
    ORDER BY pe.is_me DESC, pe.name
    LIMIT 5
  ) preview
) cast_list ON true
`

/* eslint-disable @typescript-eslint/no-explicit-any */
async function toSummary(r: any): Promise<ProjectSummary> {
  const now = today()
  const daysSinceActivity = daysSince(r.last_activity_at) ?? 0
  const attention = attentionReason({
    status: r.status,
    daysSinceActivity,
    openTasks: r.open_tasks,
    overdueTasks: r.overdue_tasks,
    worstOverdueDays: r.worst_overdue_date ? daysBetween(r.worst_overdue_date, now) : 0,
    deadlineDays: r.deadline ? daysBetween(now, r.deadline) : null
  })
  return {
    ...mapProject(r, await readIcon(r.icon_path ?? '')),
    workspaceName: r.workspace_name,
    workspaceColor: r.workspace_color,
    openTasks: r.open_tasks,
    overdueTasks: r.overdue_tasks,
    nextDue: r.next_due ?? null,
    peopleCount: r.people_count,
    myRoles: r.my_roles ?? '',
    castPreview: await Promise.all(
      (r.cast_preview ?? []).map(async (c: any) => ({
        name: c.name,
        color: c.color,
        role: c.role,
        avatar: await readIcon(c.avatar_path ?? '')
      }))
    ),
    attention
  }
}

export async function projectSummaries(
  where = '',
  params: unknown[] = [],
  orderBy = 'p.is_pinned DESC, p.last_activity_at DESC'
): Promise<ProjectSummary[]> {
  const sql = `${PROJECT_SELECT} ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy}`
  const rows = await q<any>(sql, [today(), ...params])
  return Promise.all(rows.map(toSummary))
}

export async function projectSummary(id: string): Promise<ProjectSummary | null> {
  const list = await projectSummaries('p.id = $2', [id])
  return list[0] ?? null
}

const TASK_SELECT = /* sql */ `
SELECT t.*, p.name AS project_name, p.color AS project_color, p.workspace_id,
       w.name AS workspace_name, w.color AS workspace_color,
       asg.name AS assignee_name, asg.avatar_path AS assignee_avatar_path,
       asg.avatar_color AS assignee_color, COALESCE(asg.is_me, false) AS assignee_is_me
FROM task t
JOIN project p ON p.id = t.project_id
JOIN workspace w ON w.id = p.workspace_id
LEFT JOIN person asg ON asg.id = t.assignee_person_id
`

export async function taskViews(
  where = '',
  params: unknown[] = [],
  orderBy = "t.due_date NULLS LAST, t.sort_order, t.created_at"
): Promise<TaskView[]> {
  const sql = `${TASK_SELECT} ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy}`
  const rows = await q<any>(sql, params)
  return Promise.all(
    rows.map(async (r) => mapTaskView({ ...r, assignee_avatar: await readIcon(r.assignee_avatar_path ?? '') }))
  )
}

/**
 * A meeting carries the two things a list of meetings has to show without being
 * opened: who was in the room, and what is still owed. Both come back as JSON from
 * a lateral join rather than a second round of queries per meeting.
 *
 * A to-do that has been put on the board stops answering for itself — `done` is read
 * off the card, so ticking the card on the board ticks the item on the meeting and
 * the two can never drift.
 */
const MEETING_SELECT = /* sql */ `
SELECT m.*,
       COALESCE(a.attendees, '[]'::json) AS attendees,
       COALESCE(td.todos, '[]'::json)    AS todos
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
LEFT JOIN LATERAL (
  SELECT json_agg(item) AS todos FROM (
    SELECT mt.id, mt.meeting_id, mt.text, mt.task_id, mt.sort_order,
           COALESCE(tk.status = 'done', mt.done) AS done,
           c.name AS task_column
    FROM meeting_todo mt
    LEFT JOIN task tk ON tk.id = mt.task_id
    LEFT JOIN board_column c ON c.id = tk.column_id
    WHERE mt.meeting_id = m.id
    ORDER BY mt.sort_order, mt.created_at
  ) item
) td ON true
`

/**
 * Recordings for a set of meetings, in one round trip.
 *
 * Deliberately not folded into the lateral joins above. A timestamptz that goes
 * through `json_agg` comes back as a string in whatever shape Postgres felt like
 * rendering it, and every date in this app is an ISO string the renderer can trust;
 * fetching the rows as rows keeps them going through the same `iso()` the rest of
 * the mapping uses.
 */
async function recordingsFor(meetingIds: string[]): Promise<Map<string, RecordingView>> {
  const byMeeting = new Map<string, RecordingView>()
  if (meetingIds.length === 0) return byMeeting

  const rows = await q<any>('SELECT * FROM recording WHERE meeting_id = ANY($1::uuid[])', [meetingIds])
  if (rows.length === 0) return byMeeting

  const segments = await q<any>(
    'SELECT * FROM recording_segment WHERE recording_id = ANY($1::uuid[]) ORDER BY ord',
    [rows.map((r) => r.id)]
  )
  for (const row of rows) {
    byMeeting.set(
      row.meeting_id,
      mapRecording(row, segments.filter((s) => s.recording_id === row.id).map(mapSegment))
    )
  }
  return byMeeting
}

export async function meetingViews(
  where = '',
  params: unknown[] = [],
  orderBy = 'm.occurred_on DESC, m.created_at DESC'
): Promise<MeetingView[]> {
  const sql = `${MEETING_SELECT} ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy}`
  const rows = await q<any>(sql, params)
  const recordings = await recordingsFor(rows.map((r) => r.id))
  return Promise.all(
    rows.map(async (r) => ({
      ...mapMeeting(r),
      recording: recordings.get(r.id) ?? null,
      attendees: await Promise.all(
        (r.attendees ?? []).map(async (att: any) => ({
          id: att.id,
          name: att.name,
          color: att.color,
          role: att.role,
          avatar: await readIcon(att.avatar_path ?? '')
        }))
      )
    }))
  )
}
