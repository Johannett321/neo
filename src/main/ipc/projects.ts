import type {
  Project, ProjectCollapsible, ProjectCollapsibleView, ProjectDetail, ProjectFolder,
  ProjectFolderView, ProjectStatus, ReentryBrief
} from '@shared/types'
import { daysSince, q, q1 } from '../db/client'
import {
  mapActivity, mapCast, mapCollapsible, mapCollapsibleView, mapColumn, mapDecision, mapFolder,
  mapFolderView, mapJournal, mapLink, mapNote, mapProject
} from '../db/map'
import { meetingViews, projectSummaries, projectSummary, taskViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { deleteIcon, readIcon } from '../lib/icons'
import { pruneRecordings } from '../lib/recording/store'
import { ensureColumns } from '../lib/board'
import { ensureMe } from '../lib/profile'
import { contentFolderTree, MAX_FOLDER_DEPTH } from '../lib/folders'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, remove, reorder, updateWhere, upsert } from './util'

/**
 * Re-opening a project within half an hour is the same visit, so the brief does not
 * evaporate the moment you click into it. Only a genuine return rolls the clock.
 */
const SAME_VISIT_MINUTES = 30

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
 * The collapsible a project is being put into, checked before it is written.
 *
 * Two things have to hold, and the second is the one that keeps grouping from arguing
 * with filing: the band must be in this workspace, and it must be drawn at the same
 * level the project is filed at. A card in a band on another folder's page would be
 * both filed here and grouped there, and neither page could draw it honestly.
 */
async function checkCollapsible(
  collapsibleId: unknown,
  workspaceId: string,
  folderId: string | null
): Promise<void> {
  if (collapsibleId === null || collapsibleId === undefined) return
  const band = await q1<any>(
    'SELECT workspace_id, folder_id FROM project_collapsible WHERE id = $1',
    [collapsibleId]
  )
  if (!band) throw new Error('That collapsible no longer exists.')
  if (band.workspace_id !== workspaceId) {
    throw new Error('A project cannot be grouped in another workspace\u2019s collapsible.')
  }
  if ((band.folder_id ?? null) !== folderId) {
    throw new Error('A collapsible only holds projects filed at the level it is drawn at.')
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
      /*
       * Rolled here rather than in a CASE inside the statement. The decision is the
       * same one `midVisit` above has already made, and it has to be made *before*
       * the write so that the value travels in the op: `now()` evaluated by whichever
       * database replays this would put the visit on the day of the replay.
       */
      await upsert('project', {
        previousOpenedAt: midVisit || !project.lastOpenedAt
          ? project.previousOpenedAt ?? null
          : project.lastOpenedAt,
        lastOpenedAt: new Date()
      }, id)
    }

    await ensureColumns(id)
    const [
      columns, tasks, cast, links, notes, meetings, decisions, journal, activity, contentFolders
    ] = await Promise.all([
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
      q<any>('SELECT * FROM activity WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40', [id]),
      contentFolderTree(id)
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
      // One walk of the tree, split by the list each folder belongs to — the two never
      // see each other, so neither screen has to remember to filter.
      noteFolders: contentFolders.filter((f) => f.kind === 'note'),
      meetingFolders: contentFolders.filter((f) => f.kind === 'meeting'),
      decisions: decisions.map(mapDecision),
      journal: journal.map(mapJournal),
      activity: activity.map(mapActivity)
    }
    return detail
  })

  handle('project:save', async (draft) => {
    const fields = pick(draft as Partial<Project>, [
      'workspaceId', 'name', 'summary', 'iconPath', 'color', 'deadline', 'status', 'folderId',
      'collapsibleId', 'isPinned', 'createdAt'
    ])
    if (fields.createdAt !== undefined) fields.createdAt = startedOn(String(fields.createdAt))

    if (fields.folderId !== undefined || fields.collapsibleId !== undefined) {
      const current = draft.id
        ? await q1<any>(
            'SELECT workspace_id, folder_id, collapsible_id FROM project WHERE id = $1',
            [draft.id]
          )
        : null
      const workspaceId = String((fields.workspaceId as string | undefined) ?? current?.workspace_id ?? '')

      if (fields.folderId !== undefined) {
        await checkFolder(fields.folderId, workspaceId)
        /*
         * A card carries no place with it into a folder it has just been filed in. Its
         * old number described where it sat among its old neighbours and means nothing
         * beside its new ones, so it goes back to zero — unplaced, and therefore at the
         * top of wherever it has landed, which is also where you are looking for it
         * immediately after dropping it there.
         *
         * The band it was in goes the same way and for the same reason: a collapsible
         * is drawn on one folder's page, and the card has just left that page. Unless
         * the caller named one in the same breath, in which case it is answering the
         * question itself.
         */
        if ((current?.folder_id ?? null) !== (fields.folderId ?? null)) {
          fields.sortOrder = 0
          if (fields.collapsibleId === undefined) fields.collapsibleId = null
        }
      }

      if (fields.collapsibleId !== undefined) {
        const folderId = ((fields.folderId !== undefined ? fields.folderId : current?.folder_id) ??
          null) as string | null
        await checkCollapsible(fields.collapsibleId, workspaceId, folderId)
        // Moving between bands is filing too, so the same rule applies: the number
        // described neighbours the card no longer has.
        if ((current?.collapsible_id ?? null) !== (fields.collapsibleId ?? null)) fields.sortOrder = 0
      }
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
      const already = await q1<{ id: string }>(
        'SELECT id FROM membership WHERE person_id = $1 AND project_id = $2',
        [mePersonId, project.id]
      )
      if (!already) await upsert('membership', { personId: mePersonId, projectId: project.id, role: '' })
      await logActivity(project.id, 'project_created', `Project created: ${project.name}`)
    }
    if (statusWas && statusWas !== project.status) {
      await logActivity(project.id, 'state_updated', STATUS_SAID[project.status] ?? project.status)
    }
    await mirrorProject(project.id)
    return project
  })

  handle('project:setArchived', async ({ id, archived }) => {
    const row = await upsert<any>('project', { archivedAt: archived ? new Date() : null }, id)
    if (!row) throw new Error('Project not found')
    const project = mapProject(row, await readIcon(row.icon_path ?? ''))
    await logActivity(project.id, 'state_updated', archived ? 'Archived' : 'Restored from the archive')
    return project
  })

  /*
   * Arranging the cards writes nothing to the log and rewrites no mirror. Where a card
   * sits in the grid is not a fact about the project — it is the same kind of thing as
   * which folder it is filed in, and less than that: nothing derives from it, nothing
   * on disk mentions it, and a re-entry brief that said "you moved this card left"
   * would be the log describing the furniture.
   */
  handle('project:reorder', async ({ ids }) => {
    await reorder('project', ids)
  })

  handle('project:delete', async ({ id }) => {
    const row = await q1<any>('SELECT icon_path FROM project WHERE id = $1', [id])
    await remove('project', id)
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
    const movedIds = await updateWhere('project', { folderId: id }, { folderId: folder.parent_id })
    const moved = movedIds.map((projectId) => ({ id: projectId }))
    await updateWhere('project_folder', { parentId: id }, { parentId: folder.parent_id })
    /*
     * The bands drawn on its page come up with the cards that are in them. They have to
     * travel together: a collapsible only ever holds projects filed at the level it is
     * drawn at, and lifting one side of that without the other would leave a card
     * grouped on a page it is no longer on.
     */
    await updateWhere('project_collapsible', { folderId: id }, { folderId: folder.parent_id })
    await remove('project_folder', id)
    // Where a project is filed is part of the path it is mirrored to.
    for (const project of moved) await mirrorProject(project.id)
  })

  handle('folder:reorder', async ({ ids }) => {
    await reorder('project_folder', ids)
  })

  /*
   * ------------------------------------------------------------- collapsibles
   *
   * Grouping in place: a named band of cards, below the loose ones, on the page they
   * are already on. Filing without going anywhere, which is why none of this logs
   * activity and none of it touches the Markdown mirror — where a card is drawn is not
   * a fact about the project, exactly as its position in the grid is not.
   */

  handle('collapsible:list', async ({ workspaceId }) => {
    const rows = await q<any>(
      `SELECT c.*, COALESCE(n.project_count, 0) AS project_count
       FROM project_collapsible c
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS project_count
         FROM project p
         WHERE p.collapsible_id = c.id AND p.archived_at IS NULL
       ) n ON true
       WHERE c.workspace_id = $1
       ORDER BY c.sort_order, lower(c.name)`,
      [workspaceId]
    )
    return rows.map(mapCollapsibleView) as ProjectCollapsibleView[]
  })

  handle('collapsible:save', async (draft) => {
    const fields = pick(draft as Partial<ProjectCollapsible>, [
      'workspaceId', 'folderId', 'name', 'sortOrder', 'isCollapsed'
    ])
    if (fields.name !== undefined) {
      const name = String(fields.name).trim()
      if (!name) throw new Error('A collapsible needs a name.')
      fields.name = name
    }

    const existing = draft.id
      ? await q1<any>('SELECT * FROM project_collapsible WHERE id = $1', [draft.id])
      : null
    if (draft.id && !existing) throw new Error('That collapsible no longer exists.')
    const workspaceId = (fields.workspaceId as string | undefined) ?? existing?.workspace_id
    if (!workspaceId) throw new Error('A collapsible belongs to a workspace.')
    await checkFolder(fields.folderId, String(workspaceId))

    /*
     * The level is fixed when it is made. Every project in a band is filed at the level
     * the band is drawn at, so moving the band alone would strand its cards; there is
     * no gesture for it, and refusing here is what keeps that true rather than leaving
     * a channel that quietly breaks the invariant everything else relies on.
     */
    if (existing && fields.folderId !== undefined &&
        (existing.folder_id ?? null) !== (fields.folderId ?? null)) {
      throw new Error('A collapsible stays on the page it was made on.')
    }

    // New ones go to the end of the level they are made in, under the bands already there.
    if (!draft.id && fields.sortOrder === undefined) {
      const max = await q1<{ n: number }>(
        `SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM project_collapsible
         WHERE workspace_id = $1 AND folder_id IS NOT DISTINCT FROM $2`,
        [workspaceId, fields.folderId ?? null]
      )
      fields.sortOrder = max?.n ?? 1
    }

    return mapCollapsible(await upsert<any>('project_collapsible', fields, draft.id))
  })

  handle('collapsible:delete', async ({ id }) => {
    /*
     * The band goes and the cards stay, back among the loose ones above it — the same
     * bargain a folder makes. Nothing to confirm and nothing to mirror: the projects
     * themselves have not moved anywhere on disk.
     */
    await updateWhere('project', { collapsibleId: id }, { collapsibleId: null })
    await remove('project_collapsible', id)
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
        await updateWhere('board_column', { projectId, isDone: true }, { isDone: false })
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
    await updateWhere('task', { columnId: id }, { columnId: remaining[0].id })
    await remove('board_column', id)
  })

  handle('column:reorder', async ({ ids }) => {
    await reorder('board_column', ids)
  })
}
