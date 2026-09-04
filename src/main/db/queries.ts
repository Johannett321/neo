import type { ProjectSummary, TaskView } from '@shared/types'
import { computeHealth } from '../lib/health'
import { readIcon } from '../lib/icons'
import { daysBetween, daysSince, q, today } from './client'
import { mapProject, mapTaskView } from './map'

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
    ORDER BY pe.is_me DESC, m.is_escalation DESC, pe.name
    LIMIT 5
  ) preview
) cast_list ON true
`

/* eslint-disable @typescript-eslint/no-explicit-any */
async function toSummary(r: any): Promise<ProjectSummary> {
  const now = today()
  const daysSinceActivity = daysSince(r.last_activity_at) ?? 0
  const health = computeHealth({
    status: r.status,
    daysSinceActivity,
    openTasks: r.open_tasks,
    overdueTasks: r.overdue_tasks,
    worstOverdueDays: r.worst_overdue_date ? daysBetween(r.worst_overdue_date, now) : 0,
    deadlineDays: r.deadline ? daysBetween(now, r.deadline) : null,
    hasNextAction: Boolean((r.next_action ?? '').trim())
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
    health
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
SELECT t.*, p.name AS project_name, p.workspace_id,
       w.name AS workspace_name, w.color AS workspace_color,
       l.name AS lane_name,
       asg.name AS assignee_name, asg.avatar_path AS assignee_avatar_path,
       asg.avatar_color AS assignee_color, COALESCE(asg.is_me, false) AS assignee_is_me
FROM task t
JOIN project p ON p.id = t.project_id
JOIN workspace w ON w.id = p.workspace_id
LEFT JOIN lane l ON l.id = t.lane_id
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
