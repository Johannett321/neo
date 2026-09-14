import { api, must } from '../lib/cloud/client'
import { handle, withoutId } from './util'

export function registerMeetingHandlers(): void {
  handle('meeting:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/meetings/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/meetings', { body: withoutId(draft) })))

  handle('meeting:suggestName', ({ id }) =>
    must(api.POST('/v1/meetings/{id}/suggested-name', { params: { path: { id } } })))

  handle('meeting:delete', async ({ id }) => {
    await must(api.DELETE('/v1/meetings/{id}', { params: { path: { id } } }))
  })

  handle('meetingTodo:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/meeting-todos/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/meeting-todos', { body: withoutId(draft) })))

  handle('meetingTodo:delete', async ({ id }) => {
    await must(api.DELETE('/v1/meeting-todos/{id}', { params: { path: { id } } }))
  })

  handle('meetingTodo:promote', ({ id, columnId }) =>
    must(api.POST('/v1/meeting-todos/{id}/promote', { params: { path: { id } }, body: { columnId } })))
}
