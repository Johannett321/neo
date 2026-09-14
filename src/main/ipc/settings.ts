import { app, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PANELS } from '@shared/panels'
import type { Settings } from '@shared/types'
import { api, must } from '../lib/cloud/client'
import { loadSession } from '../lib/cloud/session'
import { setGlass } from '../lib/glass'
import { handOver } from '../lib/splash'
import { setUpdatePreference } from '../lib/updater'
import { handle } from './util'

/**
 * What the app looks like before anybody is signed in: the sign-in screen still has a
 * theme to be drawn in. These are the same defaults Neo Cloud fills in for an account
 * that has never changed anything.
 */
export const SIGNED_OUT_SETTINGS: Omit<Settings, 'appVersion'> = {
  activeWorkspaceId: '',
  onboardedAt: '',
  theme: 'system',
  glassTransparency: 45,
  clockFormat: 'system',
  dateFormat: 'system',
  temperatureUnits: 'system',
  notifications: true,
  notifyAt: '09:00',
  notifyWeekends: false,
  updates: 'automatic',
  lastSeenVersion: '',
  staleAfterDays: 7,
  horizonDays: 21,
  sidebarWidth: PANELS.sidebar.default,
  assistantWidth: PANELS.assistant.default,
  meetingWidth: PANELS.meeting.default,
  captureSystemAudio: true,
  systemAudioDevice: ''
}

async function readSettings(): Promise<Settings> {
  if (!loadSession()) return { ...SIGNED_OUT_SETTINGS, appVersion: app.getVersion() }
  const stored = await must(api.GET('/v1/settings'))
  return { ...stored, appVersion: app.getVersion() }
}

export function registerSettingsHandlers(): void {
  handle('settings:get', readSettings)

  handle('settings:save', async (patch) => {
    const { appVersion: _version, ...rest } = patch
    const saved = await must(api.PATCH('/v1/settings', { body: rest }))
    const settings: Settings = { ...saved, appVersion: app.getVersion() }
    // The runner holds the preference rather than asking before every tick, because
    // `off` has to mean no request rather than a request whose answer is thrown away.
    setUpdatePreference(settings.updates)
    return settings
  })

  /**
   * Everything in the account, as JSON, wherever the person says. The one file this app
   * writes, and only because it was asked to.
   */
  handle('settings:exportJson', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Export everything as JSON',
      defaultPath: join(app.getPath('downloads'), `neo-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    const dump = await must(api.GET('/v1/data/export'))
    await writeFile(result.filePath, JSON.stringify(dump, null, 2), 'utf8')
    return { path: result.filePath }
  })

  handle('settings:loadSample', async () => {
    await must(api.POST('/v1/data/sample'))
  })

  handle('settings:wipe', async () => {
    await must(api.DELETE('/v1/data'))
  })

  /*
   * The theme's other half, and the half that can fail. What comes back is not the
   * setting: it is what this machine could actually give.
   */
  handle('window:glass', ({ on }) => ({ material: setGlass(on) }))

  // The splash screen's cue to leave.
  handle('window:ready', () => handOver())

  handle('shell:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
