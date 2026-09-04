import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { dataRoot } from './db/client'
import { mirrorAll } from './lib/markdown'

/**
 * Menu items that the renderer has to act on — navigation, dialogs — are sent as
 * commands rather than reaching into the UI from here. Anything that is genuinely the
 * main process's job (exporting, revealing the data folder) is done here directly.
 */
export type MenuCommand =
  | 'new'
  | 'new-project'
  | 'new-workspace'
  | 'search'
  | 'settings'
  | 'workspace-settings'
  | 'back'
  | 'forward'
  | `go:${string}`

function send(command: MenuCommand): void {
  // Fall back to the only window: a menu can be used while the window is unfocused.
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send('menu', command)
}

const isMac = process.platform === 'darwin'

export function buildAppMenu(): void {
  const name = app.getName()

  const goItem = (label: string, path: string, key: string): MenuItemConstructorOptions => ({
    label,
    accelerator: `CmdOrCtrl+${key}`,
    click: () => send(`go:${path}`)
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: name,
            submenu: [
              { role: 'about' as const, label: `About ${name}` },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('settings')
              },
              {
                label: 'Workspace Settings…',
                click: () => send('workspace-settings')
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: `Hide ${name}` },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `Quit ${name}` }
            ]
          }
        ]
      : []),

    {
      label: 'File',
      submenu: [
        { label: 'New Item…', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-project') },
        { label: 'New Workspace…', click: () => send('new-workspace') },
        { type: 'separator' },
        {
          label: 'Rebuild Markdown Mirror',
          click: async () => {
            await mirrorAll()
          }
        },
        {
          label: 'Reveal Data Folder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            void shell.openPath(dataRoot())
          }
        },
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close' as const }]
          : [
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('settings')
              },
              { role: 'quit' as const }
            ])
      ]
    },

    {
      // The standard roles matter here: without them text fields lose undo, redo and
      // the system emoji picker.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+K', click: () => send('search') },
        ...(isMac
          ? [
              { type: 'separator' as const },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }]
              }
            ]
          : [])
      ]
    },

    {
      label: 'Go',
      submenu: [
        goItem('Today', '/', '1'),
        goItem('Projects', '/projects', '2'),
        goItem('People', '/people', '3'),
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') }
      ]
    },

    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    { role: 'windowMenu' },

    {
      role: 'help',
      submenu: [
        {
          label: 'Where Your Data Lives',
          click: () => {
            void shell.openPath(dataRoot())
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
