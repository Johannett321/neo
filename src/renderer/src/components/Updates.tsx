import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/update'
import { RELEASES_PAGE } from '@shared/update'
import { call, openExternal, useApi, useApiMutation } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { Markdown } from '@/components/Markdown'
import { Field, Panel } from '@/components/primitives'

/**
 * The app keeping itself current, as far as anybody has to see it.
 *
 * Almost all of this is deliberately invisible. A release is found, fetched and
 * parked without a word, and the only thing that ever appears unbidden is one quiet
 * button in the corner of the header saying the new version is ready when you next
 * close the app. There is no modal in the middle of a Tuesday, no "later" to press
 * nineteen times, and nothing to drag anywhere.
 *
 * What *does* get a screen of its own is the other end: the first launch after an
 * update, which is where the changelog lives — see `WhatsNew.tsx`.
 */

/**
 * The status, kept live.
 *
 * Fetched once and then pushed: the runner ticks whether or not this pane is open,
 * so polling it would be a query on a timer for something that already knows how to
 * announce itself. Same shape as the recording bar's subscription, for the same
 * reason.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const initial = useApi('update:status')
  const [live, setLive] = useState<UpdateStatus | null>(null)
  useEffect(() => window.api.onUpdate(setLive), [])
  return live ?? initial.data ?? null
}

/**
 * One line in the header, and only when there is something to say.
 *
 * It appears for exactly two states — something waiting to be fetched that the
 * settings say to ask about first, and something already fetched and ready. Checking,
 * downloading and being up to date are all silent here: they belong in the settings
 * pane, where somebody has gone looking.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const status = useUpdateStatus()
  const [restarting, setRestarting] = useState(false)
  if (!status) return null

  if (status.phase === 'ready') {
    return (
      <button
        className="btn btn-sm gap-1.5 border-success/30 bg-success/10 text-success hover:bg-success/20"
        disabled={restarting}
        title={`Neo ${status.version} is downloaded and will be installed when you close the app.`}
        onClick={() => {
          setRestarting(true)
          void call('update:restart')
        }}
      >
        <Icon name="download" size={14} />
        {restarting ? 'Restarting…' : `Restart for ${status.version}`}
      </button>
    )
  }

  // Available and *not* downloading means the preference is `notify`: the person
  // asked to be told rather than to have it done, so this is the asking.
  if (status.phase === 'available') {
    return (
      <button
        className="btn btn-ghost btn-sm gap-1.5 text-base-content/70"
        title={`Neo ${status.version} is out.`}
        onClick={() => void call('update:download')}
      >
        <Icon name="download" size={14} />
        {status.version}
      </button>
    )
  }

  return null
}

const PREFERENCES = [
  {
    value: 'automatic' as const,
    label: 'Keep Neo up to date',
    detail:
      'Fetches new versions in the background and installs them the next time you close the app. Nothing to download, nothing to drag.'
  },
  {
    value: 'notify' as const,
    label: 'Tell me, and I will decide',
    detail: 'Checks for new versions and says so, but downloads nothing until you press the button.'
  },
  {
    value: 'off' as const,
    label: 'Never look',
    detail: 'No request is made at all. The button below still works when you want it to.'
  }
]

/** How far along the download is, as a sentence rather than a percentage where it can be. */
function phrase(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Looking…'
    case 'current':
      return 'This is the latest version.'
    case 'available':
      return `Neo ${status.version} is out.`
    case 'downloading':
      return `Fetching ${status.version}… ${Math.round(status.progress * 100)}%`
    case 'ready':
      return `Neo ${status.version} is ready, and will be installed when you close the app.`
    case 'unsupported':
      return status.reason
    case 'error':
      return status.reason
    default:
      return ''
  }
}

/**
 * The settings pane: what you are running, what it does about new versions, and
 * every changelog that has shipped.
 *
 * The history is here rather than anywhere else because this is the only screen in
 * the app that is about the app. It is also the answer to "what did that update
 * change again", which is a question people ask a week later, long after the screen
 * that told them has gone.
 */
export function UpdatesPane(): React.JSX.Element {
  const settings = useApi('settings:get')
  const capability = useApi('update:capability')
  const history = useApi('changelog:list')
  const save = useApiMutation('settings:save')
  const status = useUpdateStatus()
  const [open, setOpen] = useState('')

  const current = settings.data
  if (!current || !status) return <Panel>…</Panel>

  const busy = status.phase === 'checking' || status.phase === 'downloading'
  const said = phrase(status)

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium">Neo</span>
              <span className="font-mono text-[11px] text-base-content/40">{status.current}</span>
            </div>
            {said && (
              <p
                className={`mt-1 text-[12px] leading-relaxed ${
                  status.phase === 'error' ? 'text-warning' : 'text-base-content/55'
                }`}
              >
                {said}
              </p>
            )}
            {status.checkedAt && !busy && (
              <p className="mt-1 text-[11px] text-base-content/35">
                Last looked {formatDate(status.checkedAt.slice(0, 10))}.
              </p>
            )}
          </div>

          <div className="flex shrink-0 gap-2">
            {status.phase === 'available' && (
              <button className="btn btn-primary btn-sm" onClick={() => void call('update:download')}>
                Download
              </button>
            )}
            {status.phase === 'ready' && (
              <button className="btn btn-primary btn-sm" onClick={() => void call('update:restart')}>
                Restart now
              </button>
            )}
            {status.phase === 'unsupported' && (
              <button className="btn btn-sm" onClick={() => openExternal(RELEASES_PAGE)}>
                Downloads
              </button>
            )}
            <button
              className="btn btn-sm gap-1.5"
              disabled={busy}
              onClick={() => void call('update:check')}
            >
              <Icon name="refresh" size={14} className={busy ? 'animate-spin' : ''} />
              Check
            </button>
          </div>
        </div>

        {status.phase === 'downloading' && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-base-300">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${Math.round(status.progress * 100)}%` }}
            />
          </div>
        )}
      </Panel>

      <Panel>
        <Field label="New versions">
          <div className="space-y-2">
            {PREFERENCES.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-field p-1.5 transition hover:bg-base-content/[0.03]"
              >
                <input
                  type="radio"
                  name="updates"
                  className="radio radio-sm mt-0.5"
                  checked={current.updates === option.value}
                  onChange={() => save.mutate({ updates: option.value })}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-base-content/45">
                    {option.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        {/*
          Said here rather than only on the screen that hands them back, because this
          is where somebody decides whether to leave updates switched on — and the
          honest answer to "should I?" includes what it will cost every time.
        */}
        {capability.data?.resetsPermissions && (
          <p className="mt-4 text-[11px] leading-relaxed text-base-content/40">
            This build is signed ad hoc rather than with a developer certificate, so macOS
            treats each update as a new application and forgets the microphone, the audio tap
            and notifications. Neo asks for all three back on the screen it shows you after an
            update.
          </p>
        )}
      </Panel>

      {history.data && history.data.length > 0 && (
        <Panel padded={false}>
          <div className="hairline border-b px-4 py-3 text-[13px] font-medium">What has changed</div>
          {history.data.map((entry) => {
            const showing = open === entry.version
            return (
              <div key={entry.version} className="hairline border-b last:border-b-0">
                <button
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition hover:bg-base-content/[0.03]"
                  onClick={() => setOpen(showing ? '' : entry.version)}
                >
                  <Icon
                    name={showing ? 'chevronDown' : 'chevronRight'}
                    size={13}
                    className="shrink-0 opacity-40"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{entry.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-base-content/35">
                    {entry.version}
                  </span>
                </button>
                {showing && (
                  <div className="px-4 pb-4 pl-[2.1rem]">
                    <Markdown source={entry.body} className="text-[12.5px]" />
                  </div>
                )}
              </div>
            )
          })}
        </Panel>
      )}
    </div>
  )
}
