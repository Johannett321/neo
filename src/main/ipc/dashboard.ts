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

    const [overdue, dueToday, soon, projects, owed, stats] = await Promise.all([
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
      // A to-do that was promoted to a card is answered by the card, exactly as the
      // meeting list counts it — the row's own `done` stops being read the moment
      // `task_id` is set, so asking it here instead would report closed work as owing.
      //
      // Only active projects, for the same reason attention skips the others: paused,
      // dormant and done are deliberate states, and dragging their leftovers onto Today
      // is how a list you are meant to act on fills up with things you are not.
      q<any>(
        `SELECT m.id, m.title, m.occurred_on, m.project_id,
                p.name AS project_name, p.color AS project_color,
                count(*)::int AS open_todos
         FROM meeting_todo mt
         JOIN meeting m ON m.id = mt.meeting_id
         JOIN project p ON p.id = m.project_id
         LEFT JOIN task tk ON tk.id = mt.task_id
         WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND p.status = 'active'
           AND NOT COALESCE(tk.status = 'done', mt.done)
         GROUP BY m.id, m.title, m.occurred_on, m.project_id, p.name, p.color
         ORDER BY m.occurred_on DESC, m.created_at DESC`,
        [workspaceId]
      ),
      q<any>(
        `SELECT
           (SELECT count(*)::int FROM task t JOIN project p ON p.id = t.project_id
             WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND t.status = 'open') AS open_tasks,
           (SELECT count(*)::int FROM project
             WHERE workspace_id = $1 AND status = 'active' AND archived_at IS NULL) AS active_projects,
           (SELECT count(*)::int FROM person WHERE workspace_id = $1) AS people_tracked`,
        [workspaceId]
      )
    ])

    // Something late outranks something merely standing still, and among equals the
    // one nobody has touched for longest goes first.
    const needsAttention = projects
      .filter((p) => p.attention !== null)
      .sort((a, b) => b.overdueTasks - a.overdueTasks || a.lastActivityAt.localeCompare(b.lastActivityAt))
      .slice(0, 6)

    const view: TodayView = {
      today: now,
      overdue,
      dueToday,
      soon,
      needsAttention,
      owedFromMeetings: owed.map((r: any) => ({
        meetingId: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        projectColor: r.project_color ?? '',
        title: r.title,
        occurredOn: r.occurred_on,
        openTodos: r.open_todos
      })),
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
