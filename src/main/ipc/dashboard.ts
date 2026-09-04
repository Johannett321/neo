import type { TodayView } from '@shared/types'
import { addDays, q, today } from '../db/client'
import { mapActivity } from '../db/map'
import { projectSummaries, taskViews } from '../db/queries'
import { handle } from './util'

const SOON_DAYS = 7

/**
 * Every query here is fenced to a single workspace. A workspace is a separate area:
 * nothing from your day job appears while you are looking at your own company.
 * The fence is `p.workspace_id = $1` on every task query and the equivalent on the
 * aggregates — always the first parameter, so nothing can be added below it and
 * silently miss the filter.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerDashboardHandlers(): void {
  handle('dashboard:today', async ({ workspaceId }) => {
    const now = today()
    const soonEdge = addDays(now, SOON_DAYS)
    const inWorkspace = 'p.workspace_id = $1 AND p.archived_at IS NULL'

    const [overdue, dueToday, soon, projects, stats] = await Promise.all([
      taskViews(
        `${inWorkspace} AND t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < $2`,
        [workspaceId, now],
        't.due_date, t.sort_order'
      ),
      taskViews(`${inWorkspace} AND t.status = 'open' AND t.due_date = $2`, [workspaceId, now], 't.sort_order'),
      taskViews(
        `${inWorkspace} AND t.status = 'open' AND t.due_date > $2 AND t.due_date <= $3`,
        [workspaceId, now, soonEdge],
        't.due_date'
      ),
      projectSummaries("p.workspace_id = $2 AND p.archived_at IS NULL AND p.status <> 'done'", [workspaceId]),
      q<any>(
        `SELECT
           (SELECT count(*)::int FROM task t JOIN project p ON p.id = t.project_id
             WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND t.status = 'open') AS open_tasks,
           (SELECT count(*)::int FROM project WHERE workspace_id = $1 AND status = 'active') AS active_projects,
           (SELECT count(*)::int FROM person WHERE workspace_id = $1) AS people_tracked`,
        [workspaceId]
      )
    ])

    const needsAttention = projects
      .filter((p) => p.health.level === 'risk' || p.health.level === 'watch')
      .sort((a, b) => (a.health.level === 'risk' ? -1 : 1) - (b.health.level === 'risk' ? -1 : 1))
      .slice(0, 6)

    const view: TodayView = {
      today: now,
      overdue,
      dueToday,
      soon,
      needsAttention,
      stats: {
        openTasks: stats[0]?.open_tasks ?? 0,
        activeProjects: stats[0]?.active_projects ?? 0,
        peopleTracked: stats[0]?.people_tracked ?? 0
      }
    }
    return view
  })

  handle('dashboard:activity', async ({ workspaceId, limit = 40 }) => {
    const rows = await q<any>(
      `SELECT a.*, p.name AS project_name, w.color AS workspace_color
       FROM activity a
       JOIN project p ON p.id = a.project_id
       JOIN workspace w ON w.id = p.workspace_id
       WHERE p.workspace_id = $1 AND p.archived_at IS NULL
       ORDER BY a.created_at DESC LIMIT $2`,
      [workspaceId, Math.min(limit, 200)]
    )
    return rows.map((r) => ({ ...mapActivity(r), projectName: r.project_name, workspaceColor: r.workspace_color }))
  })
}
