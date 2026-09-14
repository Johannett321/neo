import { api, must } from '../lib/cloud/client'
import { handle } from './util'

export function registerDashboardHandlers(): void {
  handle('dashboard:today', ({ workspaceId }) =>
    must(api.GET('/v1/today', { params: { query: { workspaceId } } })))

  handle('dashboard:activity', ({ workspaceId, limit }) =>
    must(api.GET('/v1/activity', { params: { query: { workspaceId, limit } } })))
}
