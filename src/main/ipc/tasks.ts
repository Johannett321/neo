import { api, must } from '../lib/cloud/client'
import { handle, withoutId } from './util'

export function registerTaskHandlers(): void {
  handle('task:list', (filter) =>
    must(api.GET('/v1/tasks', { params: { query: { ...(filter ?? {}) } } })))

  handle('task:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/tasks/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/tasks', { body: withoutId(draft) })))

  handle('task:setStatus', ({ id, status }) =>
    must(api.PUT('/v1/tasks/{id}/status', { params: { path: { id } }, body: { status } })))

  handle('task:setColumn', ({ id, columnId }) =>
    must(api.PUT('/v1/tasks/{id}/column', { params: { path: { id } }, body: { columnId } })))

  handle('task:setProject', ({ id, projectId }) =>
    must(api.PUT('/v1/tasks/{id}/project', { params: { path: { id } }, body: { projectId } })))

  handle('task:delete', async ({ id }) => {
    await must(api.DELETE('/v1/tasks/{id}', { params: { path: { id } } }))
  })

  handle('task:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/tasks/order', { body: { ids } }))
  })

  handle('taskComment:list', ({ taskId }) =>
    must(api.GET('/v1/tasks/{id}/comments', { params: { path: { id: taskId } } })))

  handle('taskComment:save', ({ id, taskId, body }) => {
    if (id) return must(api.PATCH('/v1/task-comments/{id}', { params: { path: { id } }, body: { body } }))
    if (!taskId) throw new Error('A comment belongs to a card.')
    return must(api.POST('/v1/tasks/{id}/comments', { params: { path: { id: taskId } }, body: { body } }))
  })

  handle('taskComment:delete', async ({ id }) => {
    await must(api.DELETE('/v1/task-comments/{id}', { params: { path: { id } } }))
  })
}
