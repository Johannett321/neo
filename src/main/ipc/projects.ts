import { api, must } from '../lib/cloud/client'
import { detailOf } from '../lib/cloud/documents'
import { handle, withoutId } from './util'

export function registerProjectHandlers(): void {
  handle('project:list', ({ workspaceId, status, query, archived }) =>
    must(api.GET('/v1/projects', { params: { query: { workspaceId, status, query, archived } } })))

  /*
   * Opening a project is a visit — the brief describes the gap before it, then the clock
   * rolls — and reading one for some other reason is not. Two endpoints, because a GET
   * that writes is a GET a proxy can repeat.
   */
  handle('project:get', async ({ id, touch = true }) =>
    detailOf(await (touch
      ? must(api.POST('/v1/projects/{id}/visits', { params: { path: { id } } }))
      : must(api.GET('/v1/projects/{id}', { params: { path: { id } } })))))

  handle('project:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/projects/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/projects', { body: withoutId(draft) })))

  handle('project:setArchived', ({ id, archived }) =>
    must(api.PUT('/v1/projects/{id}/archived', { params: { path: { id } }, body: { archived } })))

  handle('project:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/projects/order', { body: { ids } }))
  })

  handle('project:delete', async ({ id }) => {
    await must(api.DELETE('/v1/projects/{id}', { params: { path: { id } } }))
  })

  handle('folder:list', ({ workspaceId }) =>
    must(api.GET('/v1/project-folders', { params: { query: { workspaceId } } })))

  handle('folder:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/project-folders/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/project-folders', { body: withoutId(draft) })))

  handle('folder:delete', async ({ id }) => {
    await must(api.DELETE('/v1/project-folders/{id}', { params: { path: { id } } }))
  })

  handle('folder:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/project-folders/order', { body: { ids } }))
  })

  handle('collapsible:list', ({ workspaceId }) =>
    must(api.GET('/v1/collapsibles', { params: { query: { workspaceId } } })))

  handle('collapsible:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/collapsibles/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/collapsibles', { body: withoutId(draft) })))

  handle('collapsible:delete', async ({ id }) => {
    await must(api.DELETE('/v1/collapsibles/{id}', { params: { path: { id } } }))
  })

  handle('column:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/columns/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/columns', { body: withoutId(draft) })))

  handle('column:delete', async ({ id }) => {
    await must(api.DELETE('/v1/columns/{id}', { params: { path: { id } } }))
  })

  handle('column:reorder', async ({ ids }) => {
    await must(api.PUT('/v1/columns/order', { body: { ids } }))
  })
}
