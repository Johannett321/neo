import { useEffect, useState } from 'react'
import type { PermissionName, PermissionReport } from '@shared/update'
import { call, useApi } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { Markdown } from '@/components/Markdown'
import { Modal } from '@/components/primitives'

/**
 * The first launch after an update: what changed, then — if this build cost the
 * app its permissions — a second, dedicated dialog asking for them back.
 *
 * These are two screens rather than one on purpose. A paragraph about permissions
 * tacked onto the bottom of a changelog is exactly the kind of thing a "Done"
 * click skips past without reading; putting it in its own dialog, after the
 * changelog is out of the way, gives it the one thing that made it get skipped —
 * full attention — instead of competing with release notes for it.
 *
 * Shown **once per version**, and never to a new install — `lastSeenVersion` is
 * empty until the first update, and somebody's first sight of Neo should not be a
 * list of what changed in a version they never ran. Same marker and same reasoning
 * as `onboardedAt`.
 */
export function WhatsNew(): React.JSX.Element | null {
  const settings = useApi('settings:get')
  const capability = useApi('update:capability')
  const [version, setVersion] = useState('')
  const [step, setStep] = useState<'changelog' | 'permissions' | 'done'>('changelog')
  const entry = useApi('changelog:get', { version }, { enabled: Boolean(version) })
  const resets = capability.data?.resetsPermissions ?? false
  const permissions = useApi('permission:read', undefined, { enabled: resets })

  /*
   * Latched, and written down at the same moment it is shown rather than when it is
   * closed. The marker is "this version has been announced", not "this dialog was
   * read to the end" — closing the window mid-read, or a crash, must not queue the
   * same announcement up for tomorrow. The latch is what stops the write from
   * falsifying its own condition and unmounting the dialog, exactly as the first-run
   * flow's does.
   */
  useEffect(() => {
    const current = settings.data
    if (!current || version) return
    const seen = current.lastSeenVersion
    if (seen === current.appVersion) return
    // Empty means this copy predates the marker, which is indistinguishable from a
    // new install — so it is written down and nothing is shown until the *next* one.
    if (!seen) {
      void call('settings:save', { lastSeenVersion: current.appVersion })
      return
    }
    setVersion(current.appVersion)
    void call('settings:save', { lastSeenVersion: current.appVersion })
  }, [settings.data, version])

  if (!version || step === 'done') return null

  // A release that shipped without writing a changelog says nothing at all rather
  // than opening an empty dialog with a heading in it.
  const changelog = entry.data
  if (entry.isPending) return null
  // Whether there is a second screen at all is not known until the permission
  // report is back, so the first screen's "Done" button waits for it too.
  if (resets && permissions.isPending) return null
  const reports = permissions.data ?? []
  const showPermissions = resets && reports.length > 0
  if (!changelog && !showPermissions) return null

  if (step === 'changelog' && changelog) {
    const advance = (): void => setStep(showPermissions ? 'permissions' : 'done')
    return (
      <Modal
        open
        onClose={advance}
        title={changelog.title}
        description={`Version ${version}`}
        width="max-w-2xl"
        footer={
          <button className="btn btn-primary btn-sm" onClick={advance}>
            Done
          </button>
        }
      >
        <Markdown source={changelog.body} className="text-[13px]" />
      </Modal>
    )
  }

  if (showPermissions) {
    return <PermissionsDialog reports={reports} onClose={() => setStep('done')} />
  }

  return null
}

const LABELS: Record<PermissionName, { title: string; detail: string; icon: 'mic' | 'waveform' | 'bell' }> = {
  microphone: { title: 'Microphone', detail: 'Hears the room.', icon: 'mic' },
  systemAudio: { title: 'Audio from this computer', detail: 'Hears the call.', icon: 'waveform' },
  notifications: { title: 'Notifications', detail: 'Deadlines can reach you.', icon: 'bell' }
}

/**
 * Its own dialog, deliberately louder than the rest of the app: an amber icon and a
 * one-line reason, not the paragraph the settings pane can afford. It follows the
 * changelog rather than sitting inside it, which is the whole of what makes it hard
 * to wave away without a glance — it is the only thing on screen when it appears.
 *
 * Nothing here reports a state it has not established. macOS will not say whether an
 * app may show a notification or open an audio tap, so those two start as neither
 * granted nor denied and only become one once the button has been pressed — which is
 * why the button says "Allow" and a granted row is quiet rather than boastful. And
 * there is no "grant all": three system sheets arriving at once is a stack nobody
 * reads the wording of.
 */
function PermissionsDialog({
  reports: initialReports,
  onClose
}: {
  reports: PermissionReport[]
  onClose: () => void
}): React.JSX.Element {
  const [asked, setAsked] = useState<Record<string, PermissionReport>>({})
  const [asking, setAsking] = useState('')
  const reports = initialReports.map((report) => asked[report.name] ?? report)

  return (
    <Modal
      open
      onClose={onClose}
      title="Allow Neo again"
      description={`This update reset ${reports.length === 1 ? 'a permission' : `${reports.length} permissions`} on macOS.`}
      width="max-w-sm"
    >
      <div className="flex justify-center pb-1">
        <div className="flex size-11 items-center justify-center rounded-full bg-warning/15">
          <Icon name="alert" size={20} className="text-warning" />
        </div>
      </div>

      <div className="mt-3 space-y-1">
        {reports.map((report) => {
          const label = LABELS[report.name]
          const done = report.state === 'granted'
          const gone = report.state === 'unavailable'
          return (
            <div
              key={report.name}
              className={`hairline flex items-center gap-3 rounded-field border px-3 py-2.5 ${gone ? 'opacity-45' : ''}`}
            >
              <Icon
                name={label.icon}
                size={15}
                className={done ? 'text-success' : 'text-base-content/40'}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{label.title}</div>
                <p className="text-[11px] text-base-content/45">{label.detail}</p>
              </div>
              {done ? (
                <Icon name="check" size={15} className="shrink-0 text-success" />
              ) : (
                !gone && (
                  <button
                    className="btn btn-primary btn-xs shrink-0"
                    disabled={asking === report.name}
                    onClick={async () => {
                      setAsking(report.name)
                      try {
                        const result = await call('permission:ask', { name: report.name })
                        setAsked((all) => ({ ...all, [report.name]: result }))
                      } finally {
                        setAsking('')
                      }
                    }}
                  >
                    {asking === report.name ? '…' : 'Allow'}
                  </button>
                )
              )}
            </div>
          )
        })}
      </div>

      <button className="btn btn-ghost btn-sm mt-4 w-full" onClick={onClose}>
        Done
      </button>
    </Modal>
  )
}
