/**
 * Stands in for Electron so the whole main process — database, IPC handlers,
 * exports — can be exercised in plain Node, with no window and no display.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.PM_TEST_DIR || mkdtempSync(join(tmpdir(), 'projectmanager-'))

export const app = {
  isPackaged: false,
  getPath: () => dir,
  getVersion: () => '0.0.0-test',
  setName: () => {},
  setPath: () => {},
  whenReady: async () => {}
}

const handlers = new Map()
export const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
export const shell = { openPath: async () => '', openExternal: async () => {} }
// Tests never open a picker; icon uploads are exercised by passing a stored filename.
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export class BrowserWindow {}
export const __handlers = handlers
export const __dataDir = dir
