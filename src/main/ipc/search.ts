import { api, must } from '../lib/cloud/client'
import { handle } from './util'

export function registerSearchHandlers(): void {
  handle('search:query', ({ workspaceId, q }) =>
    q.trim() ? must(api.GET('/v1/search', { params: { query: { workspaceId, q } } })) : [])
}
