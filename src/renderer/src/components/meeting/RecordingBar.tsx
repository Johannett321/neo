import { useLocation, useNavigate } from 'react-router-dom'
import { useApi } from '@/lib/api'
import { formatBytes, formatDuration } from '@/lib/format'
import { useRecorder } from '@/lib/recorder'
import { Icon } from '@/components/Icon'

/**
 * The recording, wherever you are.
 *
 * The microphone deliberately outlives the meeting page — you will look at the board
 * or answer something on Today in the middle of a call — which makes a recording the
 * one thing in this app that can be doing something important on a screen that does
 * not mention it. So it is said on every screen, in the same place, and the button
 * that stops it is on the bar rather than on the page that started it.
 *
 * That is not only convenience. A control that lives on one page can be got away
 * from, and a recording you cannot find is a recording you cannot stop.
 */
export function RecordingBar(): React.JSX.Element | null {
  const recorder = useRecorder()
  const navigate = useNavigate()
  const location = useLocation()

  // The title comes from the project rather than being carried along, so it keeps up
  // with a meeting still being named while it is recorded.
  const project = useApi(
    'project:get',
    { id: recorder.projectId ?? '', touch: false },
    { enabled: Boolean(recorder.projectId) }
  )
  const meeting = project.data?.meetings.find((m) => m.id === recorder.meetingId)

  if (recorder.status === 'idle' || !recorder.meetingId) return null

  const href = `/projects/${recorder.projectId}/meetings/${recorder.meetingId}`
  const here = location.pathname === href
  const reconnecting = recorder.status === 'reconnecting'
  const stopping = recorder.status === 'stopping'

  return (
    // Absolute within the main column rather than fixed to the window, so it centres
    // on the screen you are reading and never drifts under the assistant panel.
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center">
      <div className="glass-raised hairline pointer-events-auto flex items-center gap-3 rounded-full border bg-base-100/95 py-1.5 pl-3.5 pr-1.5 shadow-lg backdrop-blur">
        <span
          className={`size-2 shrink-0 rounded-full ${
            reconnecting ? 'bg-warning' : stopping ? 'bg-base-content/30' : 'animate-pulse bg-error'
          }`}
        />

        <span className="text-[12.5px] font-medium tabular-nums">
          {formatDuration(recorder.elapsedMs)}
        </span>

        {/* Six bars rather than twelve: this is a sign of life, not a mixing desk. */}
        <span className="flex h-3 items-end gap-[2px]">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`w-[2px] rounded-[1px] transition-all duration-100 ${
                recorder.level * 6 > i ? 'bg-primary' : 'bg-base-content/15'
              }`}
              style={{ height: `${35 + i * 11}%` }}
            />
          ))}
        </span>

        <button
          className="max-w-[16rem] truncate text-[12px] text-base-content/55 transition hover:text-base-content disabled:cursor-default disabled:hover:text-base-content/55"
          disabled={here}
          onClick={() => navigate(href)}
          title={here ? undefined : 'Back to the meeting'}
        >
          {reconnecting
            ? 'Microphone dropped — picking back up'
            : (meeting?.title || 'Untitled meeting')}
        </button>

        <span
          className="text-[11px] text-base-content/35"
          title={
            recorder.capturing === 'both'
              ? 'Recording the microphone and the computer’s own sound'
              : recorder.inputNote || 'Recording the microphone only'
          }
        >
          {recorder.capturing === 'both' ? 'mic + computer' : 'mic'}
        </span>

        <span className="text-[11px] tabular-nums text-base-content/35">
          {formatBytes(recorder.bytes)}
        </span>

        <button
          className="btn btn-sm gap-1.5 rounded-full"
          disabled={stopping}
          onClick={() => void recorder.stop()}
        >
          <Icon name="stop" size={11} />
          {stopping ? 'Finishing…' : 'Stop'}
        </button>
      </div>
    </div>
  )
}
