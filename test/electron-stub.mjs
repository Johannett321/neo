/**
 * Stands in for Electron so the whole main process — the IPC handlers, the client that
 * talks to Neo Cloud, the bridge, the export — can be exercised in plain Node, with no
 * window and no display.
 *
 * What the app keeps on this machine is the signed-in session, in the user-data folder;
 * here that is a temporary folder of its own, so a run never signs the real app out and
 * never reads its token.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.PM_TEST_DIR || mkdtempSync(join(tmpdir(), 'neo-verify-'))

export const app = {
  isPackaged: false,
  // Every folder the app asks for is the one temporary folder: `userData` is where the
  // session is sealed and the bridge's socket is opened, `downloads` is only ever the
  // export's suggested location, and nothing else is written anywhere.
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

/**
 * The pickers. A test never has a person to choose a file, so each dialog answers with
 * whatever `__dialog` says — cancelled unless a test has set an answer. That is what
 * lets `settings:exportJson` and `banner:pick` run through the handlers themselves
 * rather than through a copy of what they do after the dialog closes.
 */
export const __dialog = {
  open: { canceled: true, filePaths: [] },
  save: { canceled: true, filePath: undefined },
  /** The options the last dialog was opened with, so a test can read the suggestion. */
  lastSave: null
}
export const dialog = {
  showOpenDialog: async () => __dialog.open,
  showSaveDialog: async (options) => {
    __dialog.lastSave = options
    return __dialog.save
  },
  showErrorBox: () => {}
}
// A headless run has no microphone and nothing to ask about it. A recording is
// exercised by handing chunks of bytes to the channels, which is what the renderer
// does anyway once the browser has handed them over.
export const systemPreferences = {
  askForMediaAccess: async () => false,
  getMediaAccessStatus: () => 'not-determined'
}

/**
 * Every request the app tried to make through Electron's own network stack.
 *
 * The updater is the one thing in the app that uses it, and nothing here reaches a
 * socket, so an assertion that a switch means "no request" is checking the actual
 * absence of one rather than a returned null. Neo Cloud and the weather go through
 * Node's `fetch`, which `verify.ts` watches itself.
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
// would say so lives in Neo Cloud, which it is drawn before reaching. A headless run
// has no desktop.
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

/**
 * The OS keychain, which a headless run has no business touching.
 *
 * Reporting "not available" is the honest stub rather than a fake cipher: it takes
 * the code down the path a machine with no keychain takes — the session written to a
 * file only its owner can read — and a stub that pretended to encrypt would test a
 * path that only exists in tests.
 */
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8')
}
