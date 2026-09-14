import { api, must, upload } from '../lib/cloud/client'
import { handle, withoutId } from './util'

export function registerContentHandlers(): void {
  handle('note:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/notes/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/notes', { body: withoutId(draft) })))

  handle('note:delete', async ({ id }) => {
    await must(api.DELETE('/v1/notes/{id}', { params: { path: { id } } }))
  })

  handle('noteImage:save', ({ projectId, file }) =>
    upload('/v1/note-images', { projectId, filename: file.name, mime: file.mime },
      new Uint8Array(Buffer.from(file.data, 'base64'))))

  handle('canvas:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/canvases/{id}', {
          params: { path: { id: draft.id } },
          body: withoutId(draft) as never
        }))
      : must(api.POST('/v1/canvases', { body: withoutId(draft) as never })))

  handle('canvas:delete', async ({ id }) => {
    await must(api.DELETE('/v1/canvases/{id}', { params: { path: { id } } }))
  })

  handle('contentFolder:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/content-folders/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/content-folders', { body: withoutId(draft) })))

  handle('contentFolder:delete', async ({ id }) => {
    await must(api.DELETE('/v1/content-folders/{id}', { params: { path: { id } } }))
  })

  handle('decision:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/decisions/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/decisions', { body: withoutId(draft) })))

  handle('decision:delete', async ({ id }) => {
    await must(api.DELETE('/v1/decisions/{id}', { params: { path: { id } } }))
  })

  handle('link:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/links/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/links', { body: withoutId(draft) })))

  handle('link:delete', async ({ id }) => {
    await must(api.DELETE('/v1/links/{id}', { params: { path: { id } } }))
  })

  handle('journal:save', (draft) =>
    draft.id
      ? must(api.PATCH('/v1/journal-entries/{id}', { params: { path: { id: draft.id } }, body: withoutId(draft) }))
      : must(api.POST('/v1/journal-entries', { body: withoutId(draft) })))

  handle('journal:delete', async ({ id }) => {
    await must(api.DELETE('/v1/journal-entries/{id}', { params: { path: { id } } }))
  })
}
