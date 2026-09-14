import { api, must } from '../lib/cloud/client'
import { suggestedName } from '../lib/profile'
import { handle, withoutId } from './util'

export function registerPeopleHandlers(): void {
  handle('person:list', ({ workspaceId, query, projectId }) =>
    must(api.GET('/v1/people', { params: { query: { workspaceId, query, projectId } } })))

  handle('person:get', ({ id }) => must(api.GET('/v1/people/{id}', { params: { path: { id } } })))

  handle('person:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/people/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/people', { body: withoutId(draft) })))

  handle('person:delete', async ({ id }) => {
    await must(api.DELETE('/v1/people/{id}', { params: { path: { id } } }))
  })

  handle('membership:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/memberships/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/memberships', { body: withoutId(draft) })))

  handle('membership:roles', ({ workspaceId }) =>
    must(api.GET('/v1/roles', { params: { query: { workspaceId } } })))

  handle('membership:saveMine', ({ projectId, role }) =>
    must(api.PUT('/v1/projects/{id}/my-role', { params: { path: { id: projectId } }, body: { role } })))

  handle('membership:delete', async ({ id }) => {
    await must(api.DELETE('/v1/memberships/{id}', { params: { path: { id } } }))
  })

  handle('profile:get', () => must(api.GET('/v1/profile')))

  handle('profile:save', (patch) =>
    must(api.PATCH('/v1/profile', { body: { name: patch.name, avatarPath: patch.avatarPath } })))

  handle('profile:suggestName', async () => ({ name: await suggestedName() }))
}
