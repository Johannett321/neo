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
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  setName: () => {},
  setPath: () => {},
  quit: () => {},
  whenReady: async () => {}
}

const handlers = new Map()
export const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
export const shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} }
// Tests never open a picker; icon uploads are exercised by passing a stored filename.
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
// A headless run has no microphone and nothing to ask about it. The recording
// pipeline is exercised by writing bytes straight into a segment, which is what the
// renderer does anyway once the browser has handed them over.
export const systemPreferences = {
  askForMediaAccess: async () => false,
  getMediaAccessStatus: () => 'not-determined'
}

/**
 * Every request the app tried to make, and the reason the whole verify run can stay
 * offline: nothing here reaches a socket, so an assertion about a switch meaning
 * "no request" is checking the actual absence of one rather than a returned null.
 *
 * The updater and the weather are the only two things in the app that would use it.
 */
export const __fetches = []
export const net = {
  fetch: async (url) => {
    __fetches.push(String(url))
    throw new Error('The verify run makes no network requests.')
  }
}
export const protocol = { registerSchemesAsPrivileged: () => {}, handle: () => {} }
export const powerMonitor = { on: () => {} }
// The splash screen asks the desktop whether it is dark, because the setting that
// would say so lives in the database it is waiting for. A headless run has no desktop.
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} }
export const session = {
  defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }
}
// The assistant pushes its stream at every open window; in a test there are none,
// so a run reports through the events nobody is listening to and the loop is
// exercised all the same.
export class BrowserWindow {
  static getAllWindows = () => []
}
/**
 * The desktop, such as it is. There is nothing to show a notification on in a
 * headless run, so every one that would have been shown is kept instead — which is
 * how `verify.ts` asserts what the app said, and that it only said it once.
 */
export const __notifications = []
export class Notification {
  static isSupported = () => true
  constructor(options) {
    this.options = options
    this.listeners = new Map()
  }
  on(event, fn) {
    this.listeners.set(event, fn)
    return this
  }
  // A real one answers on `show` or `failed` a moment after this is called, and the
  // code under test waits for whichever arrives. A stub that stayed silent would
  // still pass, on the timeout, a second and a half at a time.
  show() {
    __notifications.push(this.options)
    this.listeners.get('show')?.()
  }
  close() {}
}

export const __handlers = handlers
export const __dataDir = dir
