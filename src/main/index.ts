import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { closeDb, dataRoot, initDb, q } from './db/client'
import { buildAppMenu } from './menu'
import { ensureColumnsEverywhere } from './lib/board'
import { pruneIcons } from './lib/icons'
import { ensureMeEverywhere, ensureMeOnAllProjects } from './lib/profile'
import { registerChatHandlers } from './ipc/chat'
import { registerContentHandlers } from './ipc/content'
import { registerDashboardHandlers } from './ipc/dashboard'
import { registerMeetingHandlers } from './ipc/meetings'
import { registerPeopleHandlers } from './ipc/people'
import { registerProjectHandlers } from './ipc/projects'
import { registerSearchHandlers } from './ipc/search'
import { registerSettingsHandlers } from './ipc/settings'
import { registerTaskHandlers } from './ipc/tasks'
import { registerWorkspaceHandlers } from './ipc/workspaces'

/**
 * The dev server's own URL, set by electron-vite when there is one, and the only
 * honest signal for which renderer to load.
 *
 * `app.isPackaged` cannot do this job here. Electron computes it from the name of
 * the executable — anything but `Electron` counts as packaged — and dev-branding
 * renames it to `Neo` so the dock stops lying about what you are running. That made
 * every development launch believe it was packaged and load the last production
 * build out of `out/renderer`, so nothing you changed in the renderer appeared and
 * hot reload did nothing at all.
 */
const rendererUrl = process.env.ELECTRON_RENDERER_URL

// Set before the app is ready: after that, macOS has already built the menu bar and
// it keeps saying "Electron" for the rest of the session.
app.setName('Neo')

/**
 * Two copies of the app writing the same database directory will corrupt it — PGlite
 * is an in-process engine with no lock of its own. A second launch focuses the window
 * that is already open instead.
 */
const isPrimary = app.requestSingleInstanceLock()

if (isPrimary) {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
} else {
  // Quit without ever touching the database: opening it is the damage being avoided.
  app.exit(0)
}
app.setAboutPanelOptions({
  applicationName: 'Neo',
  applicationVersion: app.getVersion(),
  credits: 'A personal command centre for running several working lives at once.'
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    // The traffic lights float over the sidebar; the sidebar reserves room for them.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#f7f7f8',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // Anything that is not the app itself opens in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

function registerHandlers(): void {
  registerWorkspaceHandlers()
  registerProjectHandlers()
  registerTaskHandlers()
  registerPeopleHandlers()
  registerContentHandlers()
  registerMeetingHandlers()
  registerDashboardHandlers()
  registerSearchHandlers()
  registerSettingsHandlers()
  // Registered last: the assistant's tools call the channels above by name.
  registerChatHandlers()
}

async function start(): Promise<void> {
  // A packaged build gets its icon from the bundle; in development the dock would
  // otherwise show Electron's.
  if (!app.isPackaged && app.dock) {
    const icon = join(app.getAppPath(), 'build/icon.png')
    if (existsSync(icon)) app.dock.setIcon(icon)
  }

  await initDb()
  await ensureMeEverywhere()
  await ensureMeOnAllProjects()
  await ensureColumnsEverywhere()
  const referenced = await q<{ icon_path: string }>(
    `SELECT icon_path FROM workspace
     UNION ALL SELECT icon_path FROM project
     UNION ALL SELECT avatar_path FROM person
     UNION ALL SELECT value FROM setting WHERE key = 'profileAvatarPath'`
  )
  await pruneIcons(referenced.map((r) => r.icon_path))
  registerHandlers()
  buildAppMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

if (isPrimary) {
  void app.whenReady().then(() =>
    start().catch((error: unknown) => {
      // A failed migration must say so rather than leaving a blank window behind.
      const message = error instanceof Error ? error.message : String(error)
      console.error('Neo failed to start:', error)
      dialog.showErrorBox(
        'Neo could not start',
        `${message}\n\nYour data in ${dataRoot()} has not been changed.`
      )
      app.exit(1)
    })
  )
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * The database has to be flushed before the process goes away. The default quit does
 * not wait for a promise, so quitting is deferred until the close has finished — this
 * is what protects the data from a half-written shutdown.
 */
let closing = false
app.on('before-quit', (event) => {
  if (closing) return
  event.preventDefault()
  closing = true
  void closeDb()
    .catch((error: unknown) => console.error('Could not close the database cleanly:', error))
    .finally(() => app.exit(0))
})

// Ctrl-C in a terminal during development deserves the same courtesy.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeDb().finally(() => process.exit(0))
  })
}
