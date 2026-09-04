import type { Task } from '@shared/types'
import { exec, q1 } from '../db/client'
import { mapTask } from '../db/map'
import { taskViews } from '../db/queries'
import { logActivity } from '../lib/activity'
import { doneColumnId, ensureColumns, firstColumnId } from '../lib/board'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, reorder, upsert } from './util'

export function registerTaskHandlers(): void {
  handle('task:list', async (filter) => {
    const f = filter ?? {}
    const clauses: string[] = []
    const params: unknown[] = []
    const add = (sql: string, value: unknown): void => {
      params.push(value)
      clauses.push(sql.replace('?', `$${params.length}`))
    }
    if (f.projectId) add('t.project_id = ?', f.projectId)
    if (f.workspaceId) add('p.workspace_id = ?', f.workspaceId)
    if (f.kind) add('t.kind = ?', f.kind)
    if (f.status) add('t.status = ?', f.status)
    return taskViews(clauses.join(' AND '), params)
  })

  handle('task:save', async (draft) => {
    const isNew = !draft.id
    const fields = pick(draft as Partial<Task>, [
      'projectId', 'laneId', 'title', 'details', 'kind', 'status', 'columnId',
      'dueDate', 'assigneePersonId', 'sortOrder'
    ])


    // A new card starts in the first column unless it was dropped somewhere specific.
    if (isNew && !fields.columnId && fields.projectId) {
      await ensureColumns(fields.projectId as string)
      fields.columnId = await firstColumnId(fields.projectId as string)
    }

    if (isNew && fields.sortOrder === undefined && fields.projectId) {
      const max = await q1<{ n: number }>(
        'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM task WHERE project_id = $1',
        [fields.projectId]
      )
      fields.sortOrder = max?.n ?? 0
    }

    const row = await upsert<Record<string, unknown>>('task', fields, draft.id, 'updated_at = now()')
    const task = mapTask(row)
    if (isNew) await logActivity(task.projectId, 'task_created', `Added: ${task.title}`)
    await mirrorProject(task.projectId)
    return task
  })

  handle('task:setStatus', async ({ id, status }) => {
    const current = await q1<{ project_id: string }>('SELECT project_id FROM task WHERE id = $1', [id])
    if (!current) throw new Error('Task not found')
    // Ticking a box on any screen also moves the card, and vice versa.
    const target =
      status === 'done' ? await doneColumnId(current.project_id) : await firstColumnId(current.project_id)

    const row = await q1<Record<string, unknown>>(
      `UPDATE task
       SET status = $2,
           completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END,
           column_id = COALESCE($3, column_id),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, target]
    )
    if (!row) throw new Error('Task not found')
    const task = mapTask(row)
    if (status === 'done') await logActivity(task.projectId, 'task_completed', `Completed: ${task.title}`)
    await mirrorProject(task.projectId)
    return task
  })

  handle('task:setColumn', async ({ id, columnId }) => {
    const column = await q1<{ is_done: boolean }>('SELECT is_done FROM board_column WHERE id = $1', [columnId])
    if (!column) throw new Error('Column not found')
    const done = column.is_done

    const row = await q1<Record<string, unknown>>(
      `UPDATE task
       SET column_id = $2,
           status = CASE WHEN $3 THEN 'done' ELSE 'open' END,
           completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, columnId, done]
    )
    if (!row) throw new Error('Task not found')
    const task = mapTask(row)
    if (done) await logActivity(task.projectId, 'task_completed', `Completed: ${task.title}`)
    await mirrorProject(task.projectId)
    return task
  })

  handle('task:delete', async ({ id }) => {
    await exec('DELETE FROM task WHERE id = $1', [id])
  })

  handle('task:reorder', async ({ ids }) => {
    await reorder('task', ids)
  })
}
