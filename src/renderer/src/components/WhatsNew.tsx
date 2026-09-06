import { useEffect, useState } from 'react'
import type { PermissionName, PermissionReport } from '@shared/update'
import { call, useApi } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { Markdown } from '@/components/Markdown'
import { Modal } from '@/components/primitives'

/**
 * The first launch after an update: what changed, and the three things macOS forgot.
 *
 * These are one screen rather than two, and that is the whole design. Updating this
 * app costs the microphone, the audio tap and notifications, every time, because
 * there is no Developer ID and macOS remembers a permission against a signature that
 * changes with every build. An app that quietly let those lapse would be an app that
 * silently stopped recording the other half of your calls — the failure would surface
 * a week later, in a meeting, as a recording with half a conversation in it.
 *
 * So the cost is paid where the benefit is being read. You open Neo, it tells you
 * what is new, and the same panel hands you three buttons that take a second each.
 * Nothing here is a warning and nothing is red: it is the receipt for an update that
 * has already happened.
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
  const [dismissed, setDismissed] = useState(false)
  const entry = useApi('changelog:get', { version }, { enabled: Boolean(version) })

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

  if (!version || dismissed) return null

  // A release that shipped without writing a changelog says nothing at all rather
  // than opening an empty dialog with a heading in it.
  const changelog = entry.data
  const resets = capability.data?.resetsPermissions ?? false
  if (entry.isPending) return null
  if (!changelog && !resets) return null

  return (
    <Modal
      open
      onClose={() => setDismissed(true)}
      title={changelog?.title ?? `Neo ${version}`}
      description={changelog ? `Version ${version}` : 'Updated just now.'}
      width="max-w-2xl"
      footer={
        <button className="btn btn-primary btn-sm" onClick={() => setDismissed(true)}>
          Done
        </button>
      }
    >
      {changelog && <Markdown source={changelog.body} className="text-[13px]" />}
      {resets && <Permissions />}
    </Modal>
  )
}

const LABELS: Record<PermissionName, { title: string; detail: string }> = {
  microphone: {
    title: 'Microphone',
    detail: 'So a meeting recording hears the room you are sitting in.'
  },
  systemAudio: {
    title: 'Audio from this computer',
    detail: 'So a recorded call captures the people on it and not only your own half.'
  },
  notifications: {
    title: 'Notifications',
    detail: 'So a deadline can still reach you on the morning it matters.'
  }
}

/**
 * The three permissions, each with a button that genuinely asks for it.
 *
 * There is no "grant all", on purpose: each of these puts a system sheet on screen,
 * and three sheets arriving at once is a stack of dialogs nobody reads the wording
 * of. One at a time, each with a sentence saying what it is for, is slower and is the
 * only version that leaves somebody knowing what they agreed to.
 *
 * Nothing here reports a state it has not established. macOS will not say whether an
 * app may show a notification or open an audio tap, so those two start as neither
 * granted nor denied and only become one once the button has been pressed — which is
 * why the button says "Allow" and the row is quiet rather than alarmed.
 */
function Permissions(): React.JSX.Element {
  const initial = useApi('permission:read')
  const [asked, setAsked] = useState<Record<string, PermissionReport>>({})
  const [asking, setAsking] = useState('')

  const reports = (initial.data ?? []).map((report) => asked[report.name] ?? report)
  if (reports.length === 0) return <></>

  return (
    <div className="hairline mt-5 rounded-box border bg-base-200/40 p-4">
      <div className="text-[13px] font-medium">Neo needs its permissions back</div>
      <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
        macOS remembers what an app is allowed to do against that app’s signature, and this
        build is signed afresh every release. So as far as your Mac is concerned Neo is new
        here again. It takes a second each.
      </p>

      <div className="mt-3 space-y-1">
        {reports.map((report) => {
          const label = LABELS[report.name]
          const done = report.state === 'granted'
          const gone = report.state === 'unavailable'
          return (
            <div
              key={report.name}
              className={`flex items-center gap-3 rounded-field px-2 py-2 ${gone ? 'opacity-45' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px]">
                  {done && <Icon name="check" size={13} className="text-success" />}
                  {label.title}
                </div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-base-content/45">
                  {report.reason || label.detail}
                </p>
              </div>
              {!gone && (
                <button
                  className={`btn btn-xs shrink-0 ${done ? 'btn-ghost' : ''}`}
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
                  {asking === report.name ? 'Asking…' : done ? 'Again' : 'Allow'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
