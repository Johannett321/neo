import { Notification } from 'electron'
import type { PendingNotification } from '@shared/types'
import { q, q1, today } from '../db/client'
import { dueNotifications } from '../lib/notify'
import { showNotification } from '../lib/notifier'
import { handle } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerNotificationHandlers(): void {
  /**
   * What this workspace would say this morning. Read-only and derived: it writes
   * nothing, remembers nothing, and calling it a hundred times has no effect on what
   * is delivered — the delivery loop is what decides that, and it decides it by
   * writing a row down.
   *
   * Fenced like everything else. `$1` is the workspace on both queries and it is the
   * first parameter, so nothing can be appended below it and quietly miss the filter.
   */
  handle('notification:pending', async ({ workspaceId }): Promise<PendingNotification[]> => {
    const workspace = await q1<any>('SELECT * FROM workspace WHERE id = $1', [workspaceId])
    // An archived workspace is out of the way, and out of the way includes silent.
    if (!workspace || workspace.archived_at || !workspace.notify) return []

    const on = today()

    // Only active projects have a deadline worth a notification: done, dormant and
    // paused are all states you put a project into on purpose, and the whole point
    // of putting it into one is that it stops asking.
    const projects = await q<any>(
      `SELECT id, name, deadline FROM project
       WHERE workspace_id = $1 AND archived_at IS NULL AND status = 'active'
         AND deadline IS NOT NULL`,
      [workspaceId]
    )

    // The same fence Today uses, word for word, and for the same reason: a paused
    // project has nothing to ask of today, so it has nothing to say tonight either.
    const tasks = await q<any>(
      `SELECT t.id, t.title, t.due_date, t.project_id, p.name AS project_name
       FROM task t JOIN project p ON p.id = t.project_id
       WHERE p.workspace_id = $1 AND p.archived_at IS NULL AND p.status <> 'paused'
         AND t.status = 'open' AND t.due_date IS NOT NULL
       ORDER BY t.due_date, t.sort_order`,
      [workspaceId]
    )

    return dueNotifications({
      on,
      workspaceId,
      workspaceName: workspace.name,
      prefs: {
        projectAheadDays: workspace.notify_project_ahead_days ?? 0,
        projectOnTheDay: workspace.notify_project_on_the_day ?? false,
        taskAheadDays: workspace.notify_task_ahead_days ?? 0,
        taskOnTheDay: workspace.notify_task_on_the_day ?? false,
        taskDayAfter: workspace.notify_task_day_after ?? false
      },
      projects: projects.map((p) => ({ id: p.id, name: p.name, deadline: p.deadline })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.due_date,
        projectId: t.project_id,
        projectName: t.project_name
      }))
    })
  })

  /**
   * One, now, on purpose — and on macOS this is also what makes the operating system
   * ask whether Neo may show them, because there is no way to raise that question
   * except by trying.
   *
   * It deliberately writes no row: a test is not a delivery, and pressing it must not
   * be the reason you never hear about tomorrow's deadline.
   */
  handle('notification:test', () =>
    showNotification({
      title: 'Neo can reach you here',
      body: 'This is what a deadline will look like.',
      target: null
    })
  )

  /** What this desktop can do, asked before anything is shown on it. */
  handle('notification:capability', () => ({
    supported: Notification.isSupported(),
    /*
     * Only macOS puts a question in front of an application before it may show a
     * notification. Windows shows one and lets you turn it off afterwards, and a
     * Linux desktop has no notion of per-app permission at all — so on both of those
     * a screen asking for consent would be asking for something nobody is being
     * asked for, which is worse than not asking.
     */
    gated: process.platform === 'darwin'
  }))
}
