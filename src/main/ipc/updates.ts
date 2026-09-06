import { listChangelog, readChangelog } from '../lib/changelog'
import { askPermission, readPermissions } from '../lib/permissions'
import {
  checkForUpdate,
  downloadUpdate,
  restartForUpdate,
  updateCapability,
  updateStatus
} from '../lib/updater'
import { handle } from './util'

/**
 * The update, the changelog and the three permissions an update costs.
 *
 * They are one file because they are one story on screen: the app replaces itself,
 * says what changed, and hands back what macOS forgot. Splitting them would put the
 * apology in a different place from the thing being apologised for.
 *
 * Nothing here writes to the database, which is why none of it announces a change.
 */
export function registerUpdateHandlers(): void {
  handle('update:status', () => updateStatus())
  // `true` — this is somebody pressing a button, so it looks even when the app has
  // been told never to look on its own.
  handle('update:check', () => checkForUpdate(true))
  handle('update:download', () => downloadUpdate())
  handle('update:restart', () => ({ restarting: restartForUpdate() }))
  handle('update:capability', () => updateCapability())

  handle('changelog:list', () => listChangelog())
  handle('changelog:get', ({ version }) => readChangelog(version))

  handle('permission:read', () => readPermissions())
  handle('permission:ask', ({ name }) => askPermission(name))
}
