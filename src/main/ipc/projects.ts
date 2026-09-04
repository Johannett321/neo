import type { Project, ProjectDetail, ReentryBrief } from '@shared/types'
import { daysSince, exec, q, q1 } from '../db/client'
import {
  mapActivity, mapCast, mapColumn, mapDecision, mapJournal, mapLink, mapMeeting, mapNote,
  mapProject
} from '../db/map'
import { projectSummaries, projectSummary, taskViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { deleteIcon, readIcon } from '../lib/icons'
import { ensureColumns } from '../lib/board'
import { ensureMe } from '../lib/profile'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, reorder, upsert } from './util'

/** Resolve each attendee's photo alongside the meeting row. */
export async function withAttendeeAvatars(row: any): Promise<import('@shared/types').MeetingView> {
  const meeting = mapMeeting(row)
  const attendees = await Promise.all(
    (row.attendees ?? []).map(async (a: any) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      role: a.role,
      avatar: await readIcon(a.avatar_path ?? '')
    }))
  )
  return { ...meeting, attendees }
}

/**
 * Re-opening a project within half an hour is the same visit, so the brief does not
 * evaporate the moment you click into it. Only a genuine return rolls the clock.
 */
const SAME_VISIT_MINUTES = 30

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerProjectHandlers(): void {
  handle('project:list', async (filter) => {
    const clauses: string[] = []
    const params: unknown[] = []
    const f = filter ?? {}
    // Archived projects are out of the way by default, on every screen.
    clauses.push(f.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL')
    if (f.workspaceId) {
      params.push(f.workspaceId)
      clauses.push(`p.workspace_id = $${params.length + 1}`)
    }
    if (f.status && f.status !== 'all') {
      params.push(f.status)
      clauses.push(`p.status = $${params.length + 1}`)
    }
    if (f.query) {
      params.push(`%${f.query}%`)
      clauses.push(`(p.name ILIKE $${params.length + 1} OR p.summary ILIKE $${params.length + 1})`)
    }
    return projectSummaries(clauses.join(' AND '), params)
  })

  handle('project:get', async ({ id, touch = true }) => {
    const project = await projectSummary(id)
    if (!project) throw new Error('Project not found')

    // The brief describes the gap before *this* visit, and must not change while
    // the visit is still going. Once the clock has been rolled, last_opened_at is
    // this visit, so the previous visit is the one to measure from.
    const openedAgoMs = project.lastOpenedAt ? Date.now() - new Date(project.lastOpenedAt).getTime() : null
    const midVisit = openedAgoMs !== null && openedAgoMs < SAME_VISIT_MINUTES * 60_000
    const since = midVisit ? project.previousOpenedAt : project.lastOpenedAt

    const changes = since
      ? (await q<any>(
          `SELECT * FROM activity WHERE project_id = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 30`,
          [id, since]
        )).map(mapActivity)
      : []

    const daysSinceOpened = daysSince(since)
    const brief: ReentryBrief = {
      daysSinceOpened,
      daysSinceActivity: daysSince(project.lastActivityAt) ?? 0,
      isReturning: daysSinceOpened !== null && daysSinceOpened >= 3,
      changes
    }

    if (touch) {
      await exec(
        `UPDATE project
         SET previous_opened_at = CASE
               WHEN last_opened_at IS NULL THEN previous_opened_at
               WHEN last_opened_at < now() - ($2 || ' minutes')::interval THEN last_opened_at
               ELSE previous_opened_at
             END,
             last_opened_at = now()
         WHERE id = $1`,
        [id, String(SAME_VISIT_MINUTES)]
      )
    }

    await ensureColumns(id)
    const [columns, tasks, cast, links, notes, meetings, decisions, journal, activity] = await Promise.all([
      q<any>('SELECT * FROM board_column WHERE project_id = $1 ORDER BY sort_order, created_at', [id]),
      taskViews('t.project_id = $1', [id]),
      q<any>(
        `SELECT m.*, p.name, p.org, p.email, p.avatar_color, p.avatar_path, p.is_me, p.how_to_work_with
         FROM membership m JOIN person p ON p.id = m.person_id
         WHERE m.project_id = $1
         ORDER BY p.is_me DESC, p.name`,
        [id]
      ),
      q<any>('SELECT * FROM link WHERE project_id = $1 ORDER BY sort_order, label', [id]),
      q<any>('SELECT * FROM note WHERE project_id = $1 ORDER BY is_pinned DESC, updated_at DESC', [id]),
      q<any>(
        `SELECT m.*, COALESCE(a.attendees, '[]'::json) AS attendees
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
         WHERE m.project_id = $1
         ORDER BY m.occurred_on DESC, m.created_at DESC`,
        [id]
      ),
      q<any>('SELECT * FROM decision WHERE project_id = $1 ORDER BY decided_on DESC, created_at DESC', [id]),
      q<any>('SELECT * FROM journal_entry WHERE project_id = $1 ORDER BY occurred_on DESC, created_at DESC', [id]),
      q<any>('SELECT * FROM activity WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40', [id])
    ])

    const detail: ProjectDetail = {
      project,
      brief,
      columns: columns.map(mapColumn),
      tasks,
      cast: await Promise.all(cast.map(async (c) => mapCast(c, await readIcon(c.avatar_path ?? '')))),
      links: links.map(mapLink),
      notes: notes.map(mapNote),
      meetings: await Promise.all(meetings.map(withAttendeeAvatars)),
      decisions: decisions.map(mapDecision),
      journal: journal.map(mapJournal),
      activity: activity.map(mapActivity)
    }
    return detail
  })

  handle('project:save', async (draft) => {
    const fields = pick(draft as Partial<Project>, [
      'workspaceId', 'name', 'summary', 'iconPath', 'color', 'deadline', 'status', 'isPinned'
    ])

    let orphan = ''
    if (draft.id && fields.iconPath !== undefined) {
      const current = await q1<any>('SELECT icon_path FROM project WHERE id = $1', [draft.id])
      if (current?.icon_path && current.icon_path !== fields.iconPath) orphan = current.icon_path
    }

    const row = await upsert<any>('project', fields, draft.id)
    if (orphan) await deleteIcon(orphan)
    const project = mapProject(row, await readIcon(row.icon_path ?? ''))

    if (!draft.id) {
      // You are on your own projects by default, so your roles are there to edit.
      await ensureColumns(project.id)
      const mePersonId = await ensureMe(project.workspaceId)
      await exec(
        `INSERT INTO membership (person_id, project_id, role) VALUES ($1, $2, '')
         ON CONFLICT DO NOTHING`,
        [mePersonId, project.id]
      )
      await logActivity(project.id, 'project_created', `Project created: ${project.name}`)
    }
    await mirrorProject(project.id)
    return project
  })

  handle('project:setArchived', async ({ id, archived }) => {
    const row = await q1<any>(
      `UPDATE project SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE id = $1 RETURNING *`,
      [id]
    )
    if (!row) throw new Error('Project not found')
    const project = mapProject(row, await readIcon(row.icon_path ?? ''))
    await logActivity(project.id, 'state_updated', archived ? 'Archived' : 'Restored from the archive')
    return project
  })

  handle('project:delete', async ({ id }) => {
    const row = await q1<any>('SELECT icon_path FROM project WHERE id = $1', [id])
    await exec('DELETE FROM project WHERE id = $1', [id])
    if (row?.icon_path) await deleteIcon(row.icon_path)
  })

  handle('column:save', async (draft) => {
    const isNew = !draft.id
    const fields = pick(draft as Partial<import('@shared/types').BoardColumn>, [
      'projectId', 'name', 'sortOrder', 'isDone'
    ])
    if (isNew && fields.sortOrder === undefined && fields.projectId) {
      const max = await q1<{ n: number }>(
        'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM board_column WHERE project_id = $1',
        [fields.projectId]
      )
      fields.sortOrder = max?.n ?? 0
    }
    // Only one column can be the finishing line.
    if (fields.isDone === true) {
      const projectId =
        fields.projectId ??
        (await q1<{ project_id: string }>('SELECT project_id FROM board_column WHERE id = $1', [draft.id]))
          ?.project_id
      if (projectId) {
        await exec('UPDATE board_column SET is_done = false WHERE project_id = $1', [projectId])
      }
    }
    const row = await upsert<any>('board_column', fields, draft.id)
    return mapColumn(row)
  })

  handle('column:delete', async ({ id }) => {
    const column = await q1<any>('SELECT project_id FROM board_column WHERE id = $1', [id])
    if (!column) return
    const remaining = await q<any>(
      'SELECT id FROM board_column WHERE project_id = $1 AND id <> $2 ORDER BY sort_order LIMIT 1',
      [column.project_id, id]
    )
    if (remaining.length === 0) throw new Error('A board needs at least one column.')
    // Cards are never deleted with their column; they fall back to the first one.
    await exec('UPDATE task SET column_id = $2 WHERE column_id = $1', [id, remaining[0].id])
    await exec('DELETE FROM board_column WHERE id = $1', [id])
  })

  handle('column:reorder', async ({ ids }) => {
    await reorder('board_column', ids)
  })
}
