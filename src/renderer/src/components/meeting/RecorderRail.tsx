import type { RecordingView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { formatBytes, formatDuration } from '@/lib/format'
import { useRecorder } from '@/lib/recorder'
import { Icon } from '@/components/Icon'
import { DeleteAudioButton } from './DeleteAudio'

/**
 * The recording, in the rail beside the write-up.
 *
 * It is small on purpose. While a meeting is running the only things worth knowing
 * are that it is running, for how long, and that the microphone can hear the room —
 * everything else belongs on the Recording screen afterwards. The meter is not
 * decoration: a silent recording that nobody noticed until the transcript came back
 * empty is the single worst outcome this feature has, and a bar that does not move
 * is the one warning that arrives in time to do something about it.
 */
export function RecorderRail({
  meetingId,
  projectId,
  recording,
  ensureSaved,
  onOpenRecording
}: {
  meetingId: string | null
  projectId: string
  recording: RecordingView | null
  /** Writes the meeting if it is still a draft, and hands back its id. */
  ensureSaved: () => Promise<string | null>
  onOpenRecording: () => void
}): React.JSX.Element {
  const recorder = useRecorder()

  /*
   * Whose recording this is, answered by recording id wherever there is one — a page
   * that has not yet learned its own meeting id would otherwise fail to recognise
   * the recording it just started, and go on to announce that some other meeting was
   * being recorded instead.
   */
  const mine =
    recorder.recordingId !== null &&
    (recording
      ? recorder.recordingId === recording.id
      : meetingId !== null && recorder.meetingId === meetingId)

  // Not knowing which meeting this page is is not the same as knowing it is another
  // one, and only the second is worth saying out loud.
  const elsewhere =
    recorder.recordingId !== null && !mine && meetingId !== null && recorder.meetingId !== meetingId

  const live = mine && recorder.status !== 'idle'

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-base-content/65">Recording</span>
        {recording && !live && (
          <span className="text-[11px] tabular-nums text-base-content/40">
            {formatDuration(recording.durationMs)}
          </span>
        )}
      </div>

      {live ? (
        <Live />
      ) : recording ? (
        <Existing
          recording={recording}
          projectId={projectId}
          // Marked as running, but nothing in this window is holding the microphone —
          // the window was reloaded or replaced. Main will mark it interrupted within
          // a few seconds; until then it must still offer a way out rather than a
          // card with no buttons on it.
          orphaned={recording.captureState === 'recording' && !mine}
          onOpen={onOpenRecording}
        />
      ) : (
        <button
          className="btn btn-sm w-full gap-1.5"
          disabled={elsewhere || recorder.status !== 'idle'}
          title={elsewhere ? 'Another meeting is being recorded' : undefined}
          onClick={async () => {
            const id = meetingId ?? (await ensureSaved())
            if (id) await recorder.start(id, projectId)
          }}
        >
          <span className="size-2 rounded-full bg-error" />
          Record this meeting
        </button>
      )}

      {recorder.error && (mine || !recorder.recordingId) && (
        <p className="mt-2 text-[11px] leading-relaxed text-error">{recorder.error}</p>
      )}
      {elsewhere && !recording && (
        <p className="mt-1.5 text-[11px] text-base-content/40">
          Another meeting is being recorded. Stop that one first.
        </p>
      )}
    </div>
  )
}

function Live(): React.JSX.Element {
  const recorder = useRecorder()
  const reconnecting = recorder.status === 'reconnecting'

  return (
    <div className="hairline rounded-field border bg-base-200/40 p-3">
      <div className="flex items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${
            reconnecting ? 'bg-warning' : 'animate-pulse bg-error'
          }`}
        />
        <span className="text-[13px] font-medium tabular-nums">
          {formatDuration(recorder.elapsedMs)}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-base-content/45">
          {formatBytes(recorder.bytes)}
        </span>
      </div>

      {/* The meter. Twelve bars is enough to see movement and not enough to distract. */}
      <div className="mt-2.5 flex h-3 items-end gap-[3px]">
        {Array.from({ length: 12 }, (_, i) => {
          const on = recorder.level * 12 > i
          return (
            <span
              key={i}
              className={`flex-1 rounded-[1px] transition-all duration-100 ${
                on ? 'bg-primary' : 'bg-base-content/12'
              }`}
              style={{ height: `${30 + i * 6}%` }}
            />
          )
        })}
      </div>

      {/* What is going in, in words, while it is going in. A recording that caught
          only your half of a call is the failure this whole feature exists to avoid,
          and the only moment it can still be fixed is while it is happening. */}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-base-content/50">
        <Icon name="mic" size={11} />
        {recorder.capturing === 'both' ? 'Microphone and computer audio' : 'Microphone only'}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-base-content/45">
        {reconnecting
          ? 'The microphone dropped out. Everything so far is saved; this picks back up on its own.'
          : recorder.inputNote ||
            'Saved to disk every second. Closing the app or losing power keeps what has been recorded.'}
      </p>

      <button
        className="btn btn-sm mt-2.5 w-full gap-1.5"
        disabled={recorder.status === 'stopping'}
        onClick={() => void recorder.stop()}
      >
        <Icon name="stop" size={12} />
        {recorder.status === 'stopping' ? 'Finishing…' : 'Stop and write it up'}
      </button>
    </div>
  )
}

/**
 * A recording that is not running. What it says depends entirely on where it is in
 * the pipeline, and the interrupted case is the one that matters: it is a decision
 * only the person who was in the room can make, so it is asked as a question rather
 * than resolved by a guess.
 */
function Existing({
  recording,
  projectId,
  orphaned,
  onOpen
}: {
  recording: RecordingView
  projectId: string
  orphaned: boolean
  onOpen: () => void
}): React.JSX.Element {
  const recorder = useRecorder()
  // Finishing an interrupted capture needs no microphone: the audio is already on
  // disk, and all that is left is to tell main it is over so the pipeline starts.
  const finish = useApiMutation('recording:stop')
  const busy = recorder.recordingId !== null

  if (recording.captureState === 'interrupted' || orphaned) {
    return (
      <div className="hairline rounded-field border border-warning/40 bg-warning/5 p-3">
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <Icon name="alert" size={13} className="text-warning" />
          Recording was interrupted
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-base-content/55">
          {formatDuration(recording.durationMs)} is safely on disk. Is the meeting still going?
        </p>
        <div className="mt-2.5 flex gap-1.5">
          <button
            className="btn btn-xs flex-1"
            disabled={busy}
            onClick={() => void recorder.resume(recording.id, recording.meetingId, projectId)}
          >
            Carry on
          </button>
          <button
            className="btn btn-xs flex-1"
            disabled={busy}
            onClick={() => finish.mutate({ id: recording.id, durationMs: recording.durationMs })}
          >
            It is over
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="hairline rounded-field border bg-base-200/40 p-3">
      <button
        className="row-hover -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-field px-1 py-0.5 text-left"
        onClick={onOpen}
      >
        <Icon name="waveform" size={14} className="shrink-0 text-base-content/45" />
        <span className="flex-1 text-[12px]">
          {recording.audioDeletedAt ? 'Transcript only' : formatBytes(recording.bytes)}
        </span>
        <Icon name="chevronRight" size={12} className="text-base-content/30" />
      </button>

      <p className="mt-1.5 text-[11px] leading-relaxed text-base-content/50">
        <PipelineLine recording={recording} />
      </p>

      {/* The only delete here takes the sound and leaves the words. Removing a
          recording outright is a different thing, and it lives on the Recording
          screen where you can see what you would be throwing away. */}
      <div className="mt-2 flex justify-end">
        <DeleteAudioButton recording={recording} />
      </div>
    </div>
  )
}

/** Where the recording is, in one sentence, in words rather than a progress bar. */
export function PipelineLine({ recording }: { recording: RecordingView }): React.JSX.Element {
  if (recording.transcriptState === 'failed') {
    return <>Transcription failed. {recording.transcriptError}</>
  }
  if (recording.transcriptState !== 'done') {
    return (
      <>
        Transcribing — {recording.transcribed} of {recording.segmentCount} parts done.
      </>
    )
  }
  if (recording.summaryState === 'failed') return <>The recap failed. {recording.summaryError}</>
  if (recording.summaryState !== 'done') {
    return recording.speakerState === 'done' || recording.speakerState === 'failed' ? (
      <>Writing the recap…</>
    ) : (
      <>Working out who is speaking…</>
    )
  }
  return <>Transcript and recap ready.</>
}
