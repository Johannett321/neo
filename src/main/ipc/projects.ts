import type {
  Project, ProjectDetail, ProjectFolder, ProjectFolderView, ProjectStatus, ReentryBrief
} from '@shared/types'
import { daysSince, exec, q, q1 } from '../db/client'
import {
  mapActivity, mapCast, mapColumn, mapDecision, mapFolder, mapFolderView, mapJournal, mapLink,
  mapNote, mapProject
} from '../db/map'
import { meetingViews, projectSummaries, projectSummary, taskViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { deleteIcon, readIcon } from '../lib/icons'
import { pruneRecordings } from '../lib/recording/store'
import { ensureColumns } from '../lib/board'
import { ensureMe } from '../lib/profile'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, reorder, upsert } from './util'

/**
 * Re-opening a project within half an hour is the same visit, so the brief does not
 * evaporate the moment you click into it. Only a genuine return rolls the clock.
 */
const SAME_VISIT_MINUTES = 30

/**
 * How far down the folder tree anything will walk.
 *
 * Not a rule about how you are allowed to file — nobody nests twenty deep — but a
 * floor under every recursive query here. A parent pointing at its own descendant is
 * impossible through `folder:save`, and a database that has been through a repair is
 * still allowed to be wrong; a walk that meets a loop must stop rather than hang the
 * process that owns the window.
 */
const MAX_FOLDER_DEPTH = 20

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The day a project began, as a timestamp the run-up can measure from.
 *
 * Most projects are older than the app's knowledge of them — you type in something you
 * have been running since spring, and a start date of "today" gives it a run-up with no
 * run in it and a deadline bar that is wrong from the moment you set it. So the date is
 * yours to move.
 *
 * Noon rather than midnight, and deliberately. `created_at` is a real timestamp, and
 * everything that reads it as a day takes the date off the front of the ISO string —
 * which is UTC. Midnight would land on the day before for everyone west of Greenwich
 * and read back as a project that started a day early. Noon is the same calendar day
 * from Auckland to Honolulu.
 */
function startedOn(value: string): string {
  const day = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`A start date must be a calendar date as YYYY-MM-DD, not "${value}".`)
  }
  return `${day}T12:00:00.000Z`
}


/**
 * What the log says when a project changes state.
 *
 * Pausing is the one thing on this list you would want to find again months later —
 * "when did we put this down?" — so it is worth a line rather than a silent column
 * write. Written the way the archive line is: what happened, not what field moved.
 */
const STATUS_SAID: Record<ProjectStatus, string> = {
  active: 'Picked back up',
  paused: 'Paused',
  dormant: 'Marked dormant',
  done: 'Marked done'
}


/**
 * The folder a project is being filed into, checked before it is written.
 *
 * Workspace isolation is a boundary, not a convention: a renderer that sent the id of
 * a folder in another working life would otherwise file the project somewhere it can
 * never be seen again, because every screen that draws folders is fenced to one
 * workspace. Null is always allowed — that is unfiling.
 */
async function checkFolder(folderId: unknown, workspaceId: string): Promise<void> {
  if (folderId === null || folderId === undefined) return
  const folder = await q1<any>('SELECT workspace_id FROM project_folder WHERE id = $1', [folderId])
  if (!folder) throw new Error('That folder no longer exists.')
  if (folder.workspace_id !== workspaceId) {
    throw new Error('A project cannot be filed in another workspace\u2019s folder.')
  }
}

/**
 * A folder and everything under it, the folder itself first.
 *
 * Used to stop a folder being dragged inside one of its own children, which would cut
 * the whole branch off from the top of the tree — the rows would still be there, and
 * nothing would ever draw them again.
 */
async function branchIds(id: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `WITH RECURSIVE branch AS (
       SELECT id, 0 AS depth FROM project_folder WHERE id = $1
       UNION ALL
       SELECT f.id, branch.depth + 1
       FROM project_folder f JOIN branch ON f.parent_id = branch.id
       WHERE branch.depth < ${MAX_FOLDER_DEPTH}
     )
     SELECT id FROM branch`,
    [id]
  )
  return rows.map((r) => r.id)
}

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
      meetingViews('m.project_id = $1', [id]),
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
      meetings,
      decisions: decisions.map(mapDecision),
      journal: journal.map(mapJournal),
      activity: activity.map(mapActivity)
    }
    return detail
  })

  handle('project:save', async (draft) => {
    const fields = pick(draft as Partial<Project>, [
      'workspaceId', 'name', 'summary', 'iconPath', 'color', 'deadline', 'status', 'folderId',
      'isPinned', 'createdAt'
    ])
    if (fields.createdAt !== undefined) fields.createdAt = startedOn(String(fields.createdAt))

    if (fields.folderId !== undefined) {
      const workspaceId =
        (fields.workspaceId as string | undefined) ??
        (await q1<any>('SELECT workspace_id FROM project WHERE id = $1', [draft.id]))?.workspace_id
      await checkFolder(fields.folderId, String(workspaceId ?? ''))
    }

    // Read before the write, so the log only speaks when the state actually moved —
    // a screen that saves the whole project on every edit sends the status every time.
    let statusWas = ''
    if (draft.id && fields.status !== undefined) {
      statusWas = (await q1<any>('SELECT status FROM project WHERE id = $1', [draft.id]))?.status ?? ''
    }

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
    if (statusWas && statusWas !== project.status) {
      await logActivity(project.id, 'state_updated', STATUS_SAID[project.status] ?? project.status)
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
    // Its meetings went with it, and so did their recordings — but not the audio,
    // which is on disk and knows nothing about foreign keys.
    await pruneRecordings()
  })

  /*
   * ------------------------------------------------------------------ folders
   *
   * Filing, and only filing. A folder holds no work of its own, so none of these
   * logs activity — there is no project for the entry to belong to. What does have to
   * happen is the mirror: where a project is filed is part of the path it is written
   * to on disk, so anything that moves one rewrites it.
   */

  handle('folder:list', async ({ workspaceId }) => {
    /*
     * The whole tree in one statement, already in the order the page draws it.
     *
     * `sort_key` is what makes it depth-first: each level appends its own
     * (position, name) to its parent's, so sorting the flat result by that array is
     * the same walk as recursing into each folder in turn. The position is padded so
     * it sorts as a number would — "10" after "9", not before it.
     */
    const rows = await q<any>(
      `WITH RECURSIVE tree AS (
         SELECT f.*, ARRAY[f.name] AS path, 0 AS depth,
                ARRAY[lpad(f.sort_order::text, 6, '0') || ' ' || lower(f.name)] AS sort_key
         FROM project_folder f
         WHERE f.workspace_id = $1 AND f.parent_id IS NULL
         UNION ALL
         SELECT f.*, tree.path || f.name, tree.depth + 1,
                tree.sort_key || (lpad(f.sort_order::text, 6, '0') || ' ' || lower(f.name))
         FROM project_folder f
         JOIN tree ON f.parent_id = tree.id
         WHERE tree.depth < ${MAX_FOLDER_DEPTH}
       )
       SELECT tree.*,
              COALESCE(c.project_count, 0) AS project_count,
              COALESCE(s.folder_count, 0) AS folder_count
       FROM tree
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS project_count
         FROM project p
         WHERE p.folder_id = tree.id AND p.archived_at IS NULL
       ) c ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS folder_count
         FROM project_folder f WHERE f.parent_id = tree.id
       ) s ON true
       ORDER BY sort_key`,
      [workspaceId]
    )
    return rows.map(mapFolderView) as ProjectFolderView[]
  })

  handle('folder:save', async (draft) => {
    const fields = pick(draft as Partial<ProjectFolder>, [
      'workspaceId', 'parentId', 'name', 'sortOrder'
    ])
    if (fields.name !== undefined) {
      const name = String(fields.name).trim()
      if (!name) throw new Error('A folder needs a name.')
      fields.name = name
    }

    const existing = draft.id
      ? await q1<any>('SELECT * FROM project_folder WHERE id = $1', [draft.id])
      : null
    if (draft.id && !existing) throw new Error('That folder no longer exists.')
    const workspaceId = (fields.workspaceId as string | undefined) ?? existing?.workspace_id
    if (!workspaceId) throw new Error('A folder belongs to a workspace.')

    if (fields.parentId) {
      const parent = await q1<any>('SELECT workspace_id FROM project_folder WHERE id = $1', [fields.parentId])
      if (!parent) throw new Error('That folder no longer exists.')
      if (parent.workspace_id !== workspaceId) {
        throw new Error('A folder cannot be moved into another workspace.')
      }
      // Into itself, or into anything filed inside it: the branch would still exist
      // and nothing would ever draw it again.
      if (draft.id && (await branchIds(draft.id)).includes(String(fields.parentId))) {
        throw new Error('A folder cannot be moved inside itself.')
      }
    }

    // New folders go to the end of the level they are created in.
    if (!draft.id && fields.sortOrder === undefined) {
      const max = await q1<{ n: number }>(
        `SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM project_folder
         WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
        [workspaceId, fields.parentId ?? null]
      )
      fields.sortOrder = max?.n ?? 0
    }

    return mapFolder(await upsert<any>('project_folder', fields, draft.id))
  })

  handle('folder:delete', async ({ id }) => {
    const folder = await q1<any>('SELECT parent_id FROM project_folder WHERE id = $1', [id])
    if (!folder) return
    /*
     * Everything inside comes up a level first, so deleting a folder is only ever
     * undoing the filing — never losing a project or a whole branch of them. That is
     * also why nothing asks before it runs: there is nothing to warn about.
     */
    const moved = await q<{ id: string }>(
      'UPDATE project SET folder_id = $2 WHERE folder_id = $1 RETURNING id',
      [id, folder.parent_id]
    )
    await exec('UPDATE project_folder SET parent_id = $2 WHERE parent_id = $1', [id, folder.parent_id])
    await exec('DELETE FROM project_folder WHERE id = $1', [id])
    // Where a project is filed is part of the path it is mirrored to.
    for (const project of moved) await mirrorProject(project.id)
  })

  handle('folder:reorder', async ({ ids }) => {
    await reorder('project_folder', ids)
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
