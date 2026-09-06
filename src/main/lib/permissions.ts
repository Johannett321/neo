import { Notification, systemPreferences } from 'electron'
import type { PermissionName, PermissionReport, PermissionState } from '@shared/update'
import { startSystemAudio, stopSystemAudio, systemAudioAvailable } from './recording/systemAudio'
import { showNotification } from './notifier'

/**
 * The three things macOS forgets when Neo updates itself.
 *
 * A privacy permission on macOS is remembered against a bundle's *code signature*.
 * This app is ad-hoc signed — there is no Developer ID — so the signature is a hash
 * of the build, and a new build is, as far as the operating system is concerned, a
 * different application that has never been given anything.
 *
 * That is a real cost and the app pays it in the open: the screen that says what
 * changed also hands back the three permissions, in one place, with a button each.
 * The alternative is what the app did before this existed — a person opens a meeting
 * a week later, presses record, and finds that the half of the call that mattered
 * was never captured.
 *
 * Two of the three cannot be *read* at all. macOS has no API for "may I show a
 * notification" and none whatsoever for an audio tap: trying is the only way to ask,
 * and trying is also what puts the operating system's own question on screen. So
 * this does not pretend to report a state it cannot see — it says `unknown`, and the
 * button says "Allow" rather than "Fix", because pressing it is the question.
 */

const report = (name: PermissionName, state: PermissionState, reason = ''): PermissionReport => ({
  name,
  state,
  reason
})

/** What can be said without asking for anything. Empty away from macOS. */
export function readPermissions(): PermissionReport[] {
  if (process.platform !== 'darwin') return []

  const mic = systemPreferences.getMediaAccessStatus('microphone')
  return [
    report(
      'microphone',
      mic === 'granted' ? 'granted' : mic === 'denied' || mic === 'restricted' ? 'denied' : 'unknown',
      mic === 'denied' || mic === 'restricted'
        ? 'macOS is refusing it. System Settings › Privacy & Security › Microphone.'
        : ''
    ),
    report(
      'systemAudio',
      systemAudioAvailable() ? 'unknown' : 'unavailable',
      systemAudioAvailable()
        ? ''
        : 'This build has no audio helper, so only the microphone can be recorded.'
    ),
    report(
      'notifications',
      Notification.isSupported() ? 'unknown' : 'unavailable',
      Notification.isSupported() ? '' : 'This desktop does not show notifications at all.'
    )
  ]
}

/**
 * Ask for one, for real.
 *
 * Every branch here *does the thing* rather than describing it, because on macOS
 * that is the only way the question gets asked. The audio tap is opened and closed
 * again immediately — a fraction of a second of nothing, which is enough for Core
 * Audio to put the sheet up — and the notification is a real notification, which is
 * why it is worth one sentence rather than being blank.
 */
export async function askPermission(name: PermissionName): Promise<PermissionReport> {
  if (process.platform !== 'darwin') {
    return report(name, 'unavailable', 'Nothing to ask for on this platform.')
  }

  if (name === 'microphone') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      return report(
        'microphone',
        granted ? 'granted' : 'denied',
        granted ? '' : 'macOS said no. System Settings › Privacy & Security › Microphone.'
      )
    } catch (error) {
      return report('microphone', 'denied', error instanceof Error ? error.message : String(error))
    }
  }

  if (name === 'systemAudio') {
    if (!systemAudioAvailable()) {
      return report('systemAudio', 'unavailable', 'This build has no audio helper.')
    }
    const started = await startSystemAudio()
    // Opened only to be closed: the helper hands its device back to Core Audio when
    // its stdin closes, and leaving it running would keep a private aggregate device
    // alive for a question that has already been answered.
    stopSystemAudio()
    return report('systemAudio', started.ok ? 'granted' : 'denied', started.ok ? '' : started.reason)
  }

  const shown = await showNotification({
    title: 'Neo can reach you',
    body: 'Deadlines and due dates will arrive here again.',
    target: null
  })
  return report('notifications', shown.shown ? 'granted' : 'denied', shown.reason)
}
