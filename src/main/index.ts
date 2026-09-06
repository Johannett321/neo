import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, powerMonitor, protocol, session, shell } from 'electron'
import { closeDb, dataRoot, initDb, q } from './db/client'
import { adoptExistingRows, initOplog } from './db/oplog'
import { buildAppMenu } from './menu'
import { ensureColumnsEverywhere } from './lib/board'
import { applyGlassTo, initialBackground, initialVibrancy, presetGlass } from './lib/glass'
import { pruneIcons } from './lib/icons'
import { ensureMeEverywhere, ensureMeOnAllProjects } from './lib/profile'
import { startBridge, stopBridge } from './lib/mcp/bridge'
import { abandonSplash, openSplash, splashFor, splashOpen } from './lib/splash'
import { kickNotifications, startNotifications, stopNotifications } from './lib/notifier'
import { applyStagedUpdate, pruneStaged, startUpdates, stopUpdates } from './lib/updater'
import { MEDIA_SCHEME_PRIVILEGES, registerMediaProtocol } from './lib/recording/media'
import { kick, recoverRecordings, startPipeline, stopPipeline } from './lib/recording/pipeline'
import { pruneRecordings } from './lib/recording/store'
import { stopSystemAudio } from './lib/recording/systemAudio'
import { registerChatHandlers } from './ipc/chat'
import { registerContentHandlers } from './ipc/content'
import { registerDashboardHandlers } from './ipc/dashboard'
import { registerMcpHandlers } from './ipc/mcp'
import { registerMeetingHandlers } from './ipc/meetings'
import { registerNotificationHandlers } from './ipc/notifications'
import { registerPeopleHandlers } from './ipc/people'
import { registerProjectHandlers } from './ipc/projects'
import { registerRecordingHandlers } from './ipc/recordings'
import { registerSearchHandlers } from './ipc/search'
import { registerSettingsHandlers } from './ipc/settings'
import { registerTaskHandlers } from './ipc/tasks'
import { registerUpdateHandlers } from './ipc/updates'
import { registerWeatherHandlers } from './ipc/weather'
import { registerWorkspaceHandlers } from './ipc/workspaces'
import { invokeChannel } from './ipc/util'

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

// Windows identifies the application that a notification came from by this and by
// nothing else; without it a notification is built, shown, and never appears. It is
// harmless everywhere else, so it is not worth a platform check.
app.setAppUserModelId('com.svartdal.neo')

// Also before the app is ready, and for a similar reason: a scheme's privileges are
// read once, when the first renderer process is created. This is what lets an
// <audio> element range-request a segment of a recording without the renderer being
// given a file path it could read anything else with.
protocol.registerSchemesAsPrivileged([MEDIA_SCHEME_PRIVILEGES])

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
    /*
     * Clear whatever the theme, and vibrant whatever the theme. Neither can be undone
     * after the window is built — an opaque window can never be made clear again, and
     * `visualEffectState` below is read once and never again — so both are settled
     * here and the theme decides only what gets painted over them. See lib/glass.ts.
     *
     * Deliberately *not* `transparent: true`, which was here briefly and had to go.
     * Chromium cannot run a `backdrop-filter` in a transparent window — there is no
     * opaque backdrop for it to read — and it fails the way these things always do,
     * silently: menus and dialogs kept their translucency and quietly lost their
     * blur, so the command palette sat over the page with every word behind it still
     * legible. A clear background is enough for the vibrancy view to show through,
     * and it costs nothing, because the material above it is never absent.
     */
    backgroundColor: initialBackground(),
    vibrancy: initialVibrancy(),
    /*
     * The glass stays glass when the window is not the one you are typing in. macOS
     * turns a vibrancy view off the moment its window stops being key — it goes flat
     * grey behind whatever you switched to, which is the opposite of what you want
     * from a window you chose in order to see through it.
     */
    visualEffectState: 'active',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Again, and not only through the constructor: `activate` opens a window into an
  // app that is already running, and Windows has no constructor option for acrylic.
  applyGlassTo(window)

  /*
   * The first window of a launch is not shown by itself: the splash screen is
   * standing in for it, and it is revealed at the hand-off — once the renderer says
   * it has something real to draw — so that a blank pane never appears around the
   * mark. Every window after that (the dock icon clicked with none open, a
   * notification followed into a closed app) shows itself the moment it can.
   */
  const covered = splashOpen()
  if (covered) splashFor(window)
  window.once('ready-to-show', () => {
    if (!covered) window.show()
  })

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
  registerRecordingHandlers()
  registerDashboardHandlers()
  registerNotificationHandlers()
  registerSearchHandlers()
  registerSettingsHandlers()
  registerUpdateHandlers()
  registerWeatherHandlers()
  registerMcpHandlers()
  // Registered last: the assistant's tools call the channels above by name.
  registerChatHandlers()
}

async function start(): Promise<void> {
  /*
   * Before anything is opened, and it has to be: everything below this line — the
   * database booting, the schema, the catalogue check, the sweeps — happens with no
   * window in existence at all. Without this the whole of it is a bouncing dock icon.
   */
  openSplash()

  // A packaged build gets its icon from the bundle; in development the dock would
  // otherwise show Electron's.
  if (!app.isPackaged && app.dock) {
    const icon = join(app.getAppPath(), 'build/icon.png')
    if (existsSync(icon)) app.dock.setIcon(icon)
  }

  /*
   * The microphone. Chromium asks the application before it asks the operating
   * system, and its default answer inside Electron is no — so a recording would fail
   * with a permission error that never reached a dialog. Only the microphone is
   * granted here; everything else is still refused.
   */
  const allowed = new Set(['media', 'audioCapture'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))

  /*
   * The other half of a call: what the computer is playing.
   *
   * On Windows the operating system will hand an application its own output, and
   * `loopback` is that. On macOS it will not — Electron 44 says so in as many words,
   * and no amount of asking changes it — so nothing is offered here and the renderer
   * mixes in a virtual input device instead. A video is never captured either way;
   * this is a meeting recorder, and a screen recording of somebody's call is not a
   * thing to take by accident.
   */
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (process.platform !== 'win32') return callback({})
      callback({ audio: 'loopback' })
    },
    // Without this Electron insists on a video source, and there is nothing here that
    // wants one.
    { useSystemPicker: false }
  )

  await initDb()
  /*
   * The log comes up before anything writes to it, and the adoption pass comes before
   * the housekeeping below — `ensureMeEverywhere()` and friends all write, and they
   * must write *as themselves* rather than being swept up as rows that were always
   * here. On an install that predates the log this is the launch that gives years of
   * work its history; on every launch after it, it finds nothing and costs one query
   * per table.
   */
  await initOplog()
  const adopted = await adoptExistingRows()
  if (adopted.rows > 0) console.log(`Took ${adopted.rows} existing row(s) into the operation log.`)
  await ensureMeEverywhere()
  await ensureMeOnAllProjects()
  await ensureColumnsEverywhere()
  const referenced = await q<{ icon_path: string }>(
    `SELECT icon_path FROM workspace
     UNION ALL SELECT icon_path FROM project
     UNION ALL SELECT banner_path FROM workspace
     UNION ALL SELECT avatar_path FROM person
     UNION ALL SELECT value FROM setting WHERE key = 'profileAvatarPath'`
  )
  await pruneIcons(referenced.map((r) => r.icon_path))
  // The same sweep for audio, and the backstop for every route that could have
  // orphaned some: an hour of a meeting is the largest thing this app writes, and a
  // cascade in the database frees none of it.
  const sweptAudio = await pruneRecordings()
  if (sweptAudio > 0) console.log(`Removed ${sweptAudio} recording folder(s) with no recording left.`)
  /*
   * And the same for an update that was downloaded and never applied — a lid closed
   * on the way to the airport, a machine restarted for another reason. A staged
   * release is hundreds of megabytes and nothing will ever come back for it: if it is
   * still wanted, this launch will find it again and fetch it in the background.
   */
  const sweptUpdates = await pruneStaged()
  if (sweptUpdates > 0) console.log(`Removed ${sweptUpdates} staged update(s) that were never applied.`)
  registerHandlers()
  registerMediaProtocol()

  /*
   * Everything a recording was in the middle of is turned back into something it is
   * waiting for, and then the runner is started. This is the whole of crash
   * recovery: a machine that lost power in the middle of a two-hour meeting comes
   * back with its audio on disk, its capture marked interrupted so the person in the
   * room can decide whether it is over, and any transcription or recap it had
   * started resumed at the segment it had reached.
   */
  const interrupted = await recoverRecordings()
  if (interrupted > 0) {
    console.log(`${interrupted} recording(s) were interrupted and are waiting for you.`)
  }
  startPipeline()

  // A laptop that has been shut for a week wakes with a backlog and, more to the
  // point, with a network again — which is usually why the last attempt failed.
  // And the morning's deadlines with it, for the machine that was shut at nine and
  // opened at eleven. The tick would find them a minute later anyway; this is so that
  // opening the lid and being told are the same moment.
  const caughtUp = (): void => {
    kick()
    kickNotifications()
  }
  powerMonitor.on('resume', caughtUp)
  powerMonitor.on('unlock-screen', caughtUp)

  // Told to the window as well, because the microphone lives there and does not
  // survive a suspend. Hearing about it here is what makes a recording pick back up
  // the moment the lid opens rather than when its own watchdog next looks.
  const tellWindows = (event: 'suspend' | 'resume') => (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('power', event)
    }
  }
  powerMonitor.on('suspend', tellWindows('suspend'))
  powerMonitor.on('resume', tellWindows('resume'))

  // After the handlers, because the bridge answers by calling them, and never before
  // the database is open: the tools it exposes are the app's own channels.
  await startBridge()
  buildAppMenu()
  // Read before the window exists rather than told to it afterwards. See createWindow.
  presetGlass((await invokeChannel('settings:get')).theme)
  createWindow()

  /*
   * Last, and with the way back to a window rather than a window: on macOS the app
   * goes on running with every window closed, and a notification clicked in that
   * state has to be able to open one rather than quietly doing nothing.
   */
  startNotifications(() => {
    const [existing] = BrowserWindow.getAllWindows()
    return existing && !existing.isDestroyed() ? existing : createWindow()
  })

  // Last of all, and quietly: the first look happens half a minute in, so it is never
  // competing with the first screen for a slow connection.
  startUpdates((await invokeChannel('settings:get')).updates)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

if (isPrimary) {
  void app.whenReady().then(() =>
    start().catch((error: unknown) => {
      // A failed migration must say so rather than leaving a blank window behind.
      // Nothing is going to be handed over to, and an error box behind a window that
      // insists on staying on top is an error box nobody reads.
      abandonSplash()
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
  stopPipeline()
  stopNotifications()
  stopUpdates()
  // The helper hands its audio device back to Core Audio when its stdin closes. Left
  // running it would keep a private aggregate device alive after the app has gone.
  stopSystemAudio()
  void stopBridge()
    .catch((error: unknown) => console.error('Could not close the Claude bridge cleanly:', error))
    .then(() => closeDb())
    .catch((error: unknown) => console.error('Could not close the database cleanly:', error))
    .finally(() => {
      /*
       * The very last thing, and after the database is closed rather than before.
       * The swap waits for this process to disappear before it touches the bundle,
       * so starting it here costs nothing — and starting it any earlier would race a
       * shutdown that is still writing.
       */
      applyStagedUpdate()
      app.exit(0)
    })
})

// Ctrl-C in a terminal during development deserves the same courtesy.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stopBridge()
      .catch(() => {})
      .then(() => closeDb())
      .finally(() => process.exit(0))
  })
}
