import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CastMember, Decision, RecordingView, TranscriptCue } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { formatBytes, formatDuration, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { Markdown } from '@/components/Markdown'
import { ConfirmButton, EmptyState } from '@/components/primitives'
import { DeleteAudioButton } from './DeleteAudio'
import { PipelineLine } from './RecorderRail'

/**
 * Everything the recording turned into: the recap first, because that is what you
 * came for, then the audio and the words underneath it for the two questions a
 * recap cannot answer — "did they really say that" and "what exactly were the
 * words". The transcript follows the playhead so those two are one movement rather
 * than a search.
 */
export function RecordingPane({
  meetingId,
  projectId,
  cast,
  decisions
}: {
  meetingId: string
  projectId: string
  cast: CastMember[]
  decisions: Decision[]
}): React.JSX.Element {
  const { data } = useApi('recording:get', { meetingId })
  const recording = data?.recording ?? null
  const cues = data?.cues ?? []

  const [positionMs, setPositionMs] = useState(0)

  if (!recording) {
    return (
      <EmptyState
        icon="mic"
        title="This meeting was not recorded."
        hint="Press record in the rail on the right and Neo will keep the audio, write out what was said, and pull the decisions and commitments out of it afterwards."
      />
    )
  }

  return (
    <div className="space-y-6">
      <Recap recording={recording} projectId={projectId} decisions={decisions} />

      <Player recording={recording} positionMs={positionMs} onPosition={setPositionMs} />

      <Transcript
        recording={recording}
        cues={cues}
        positionMs={positionMs}
        onSeek={setPositionMs}
        cast={cast}
      />

      <RemoveEntirely recording={recording} />
    </div>
  )
}

/**
 * Throwing the whole thing away, transcript and recap included.
 *
 * Deliberately demoted and deliberately last, below everything it would destroy —
 * because it is almost never what you want. Freeing space is what the audio delete
 * is for, and it keeps the words. This is for the recording you should not have
 * made: the wrong room, the wrong meeting, forty minutes of a keyboard.
 */
function RemoveEntirely({ recording }: { recording: RecordingView }): React.JSX.Element {
  const remove = useApiMutation('recording:delete')

  return (
    <div className="hairline flex items-center gap-3 border-t pt-4 text-[11.5px] text-base-content/40">
      <span>
        Recorded {formatDuration(recording.durationMs)}
        {recording.audioDeletedAt ? ', audio deleted' : ` · ${formatBytes(recording.bytes)}`}.
      </span>
      <ConfirmButton
        label="Remove this recording entirely"
        title="Remove the whole recording?"
        body="The audio, the transcript, the speakers and the recap all go, and none of it can be got back. To free space and keep what was said, delete the audio instead — the button beside the player does that."
        confirmLabel="Remove everything"
        className="btn btn-ghost btn-xs ml-auto text-base-content/40 hover:text-error"
        onConfirm={() => remove.mutate({ id: recording.id })}
      />
    </div>
  )
}

/* --------------------------------------------------------------------- recap */

function Recap({
  recording,
  projectId,
  decisions
}: {
  recording: RecordingView
  projectId: string
  /** The project's decision log, so a decision already filed is not offered again. */
  decisions: Decision[]
}): React.JSX.Element {
  const retry = useApiMutation('recording:retry')
  const addDecision = useApiMutation('decision:save')
  const { recap } = recording

  // The title the log would get, so "is this already in there" compares the same
  // string that filing it would write rather than something close to it.
  const logged = new Set(decisions.map((d) => d.title.trim().toLowerCase()))

  if (recording.summaryState !== 'done') {
    return (
      <div className="hairline rounded-box border bg-base-200/30 px-4 py-3.5">
        <div className="flex items-center gap-2">
          {recording.summaryState === 'failed' || recording.transcriptState === 'failed' ? (
            <Icon name="alert" size={14} className="text-warning" />
          ) : (
            <Icon name="refresh" size={14} className="animate-spin text-base-content/40" />
          )}
          <span className="text-[13px]">
            <PipelineLine recording={recording} />
          </span>
          {(recording.summaryState === 'failed' || recording.transcriptState === 'failed') && (
            <button
              className="btn btn-xs ml-auto"
              onClick={() =>
                retry.mutate({
                  id: recording.id,
                  step: recording.transcriptState === 'failed' ? 'transcript' : 'summary'
                })
              }
            >
              Try again
            </button>
          )}
        </div>
        {recording.transcriptState !== 'done' && recording.segmentCount > 0 && (
          <p className="mt-1.5 text-[11.5px] text-base-content/45">
            This carries on without the app being open on this screen, and picks up where it
            stopped if the machine goes to sleep.
          </p>
        )}
      </div>
    )
  }

  const nothing =
    recap.decisions.length === 0 && recap.commitments.length === 0 && recap.insights.length === 0

  return (
    <div className="hairline rounded-box border bg-base-100 px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="sparkle" size={14} className="text-primary" />
        <span className="text-[13px] font-medium">Recap</span>
        <span className="text-[11px] text-base-content/35">
          {recording.summaryEngine === 'local' ? 'Written locally' : 'Written by OpenAI'} ·{' '}
          {recording.summaryModel}
        </span>
        {/* Not a button: the recap puts itself into the write-up and its commitments
            onto the meeting's to-do list. But it only says so once that has actually
            happened — a screen that claims a thing before it is true is worse than a
            screen that says nothing. */}
        {recording.recapWrittenAt ? (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-base-content/40">
            <Icon name="check" size={11} />
            In the write-up
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-base-content/40">
            <Icon name="refresh" size={11} className="animate-spin" />
            Going into the write-up…
          </span>
        )}

        {/*
          A recap that came out thin is worth another go — the prompt in workspace
          settings is yours to sharpen, and this is how you see the difference. It
          adds anything newly found to the to-do list and leaves the write-up alone,
          because appending a second recap to a page you have been editing is not
          what anybody means by "again".
        */}
        <button
          className="btn btn-ghost btn-xs gap-1 text-base-content/40"
          title="Read the transcript again and rewrite the recap"
          onClick={() => retry.mutate({ id: recording.id, step: 'summary' })}
        >
          <Icon name="refresh" size={11} />
          Again
        </button>
      </div>

      {recording.summary && (
        <Markdown source={recording.summary} className="text-[13px] leading-relaxed" />
      )}

      {recap.decisions.length > 0 && (
        <Group title="Decisions">
          {recap.decisions.map((decision, i) => {
            const title = decisionTitle(decision.what)
            // Filing the same decision twice puts it in the log twice, and the log is
            // meant to be the one place a decision is written down. So it is offered
            // once; after that the row says where it went.
            const filed = logged.has(title.toLowerCase())
            return (
              <Line
                key={i}
                text={decision.what}
                meta={decision.who}
                done={filed ? 'In the decision log' : undefined}
                action={filed ? undefined : 'File in the decision log'}
                onAction={
                  filed || addDecision.isPending
                    ? undefined
                    : () =>
                        addDecision.mutate({
                          projectId,
                          title,
                          decidedBy: decision.who,
                          decidedOn: todayStr(),
                          rationale: 'From the meeting recording.'
                        })
                }
              />
            )
          })}
        </Group>
      )}

      {/*
        Always drawn once the recap is finished, even when it is empty. A model that
        found nobody committing to anything and a feature that quietly failed look
        identical if the empty case is simply not on screen, and the first of those
        is by far the more common.
      */}
      <Group
        title="Commitments"
        note={
          recap.commitments.length === 0
            ? undefined
            : recording.recapWrittenAt
              ? "on the meeting's to-do list, in the rail"
              : 'going onto the to-do list…'
        }
      >
        {recap.commitments.length === 0 ? (
          <p className="px-1.5 py-1 text-[12px] text-base-content/40">
            Nobody said they would do anything — or nobody said it in words the recording caught.
          </p>
        ) : (
          recap.commitments.map((commitment, i) => (
            <Line
              key={i}
              text={commitment.what}
              meta={[commitment.who, commitment.due && `by ${commitment.due}`]
                .filter(Boolean)
                .join(' · ')}
            />
          ))
        )}
      </Group>

      {recap.insights.length > 0 && (
        <Group title="Worth knowing">
          {recap.insights.map((insight, i) => (
            <Line key={i} text={insight} />
          ))}
        </Group>
      )}

      {nothing && (
        <p className="mt-3 text-[12px] text-base-content/45">
          Nothing was decided either, and nothing else stood out. A short meeting, or one the
          microphone did not catch much of.
        </p>
      )}
    </div>
  )
}

function Group({
  title,
  note,
  children
}: {
  title: string
  note?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="hairline mt-4 border-t pt-3.5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-base-content/40">
          {title}
        </span>
        {note && <span className="text-[10.5px] text-base-content/35">— {note}</span>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/** The title a filed decision gets, in one place, so a comparison can match it. */
const decisionTitle = (what: string): string => what.trim().slice(0, 200)

function Line({
  text,
  meta,
  action,
  onAction,
  done
}: {
  text: string
  meta?: string
  action?: string
  onAction?: () => void
  /** Shown in place of the action once there is nothing left to do to this row. */
  done?: string
}): React.JSX.Element {
  return (
    <div className="row-hover group flex items-start gap-2 rounded-field px-1.5 py-1">
      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-base-content/25" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
        {text}
        {meta && <span className="text-base-content/45"> — {meta}</span>}
      </span>
      {action && onAction && (
        <button
          className="btn btn-ghost btn-xs shrink-0 opacity-0 transition group-hover:opacity-100"
          onClick={onAction}
        >
          {action}
        </button>
      )}
      {done && (
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-base-content/35">
          <Icon name="check" size={10} />
          {done}
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- player */

/**
 * A recording is several files, and this is what makes it sound like one.
 *
 * Position is always measured against the whole recording rather than against
 * whichever file is loaded, so the transcript, the scrubber and the clock all agree
 * across a boundary that the listener never hears. Moving to a new segment is a new
 * source; the element is asked for the byte range it wants over Neo's own scheme,
 * so seeking into an hour-long meeting does not load an hour of audio first.
 */
function Player({
  recording,
  positionMs,
  onPosition
}: {
  recording: RecordingView
  positionMs: number
  onPosition: (ms: number) => void
}): React.JSX.Element {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loaded, setLoaded] = useState<string | null>(null)

  const segments = useMemo(
    () => recording.segments.filter((s) => s.hasAudio && s.durationMs > 0),
    [recording.segments]
  )
  const total = recording.durationMs

  const segmentAt = useCallback(
    (ms: number) =>
      segments.find((s) => ms >= s.offsetMs && ms < s.offsetMs + s.durationMs) ??
      segments.find((s) => s.offsetMs + s.durationMs > ms) ??
      segments[segments.length - 1] ??
      null,
    [segments]
  )

  const seek = useCallback(
    (ms: number, resume: boolean) => {
      const element = audio.current
      const segment = segmentAt(ms)
      if (!element || !segment) return
      const within = Math.max(0, (ms - segment.offsetMs) / 1000)

      if (loaded !== segment.id) {
        setLoaded(segment.id)
        element.src = `neo-media://segment/${segment.id}`
        const onReady = (): void => {
          element.currentTime = within
          if (resume) void element.play()
        }
        element.addEventListener('loadedmetadata', onReady, { once: true })
        element.load()
      } else {
        element.currentTime = within
        if (resume) void element.play()
      }
      onPosition(ms)
    },
    [loaded, onPosition, segmentAt]
  )

  // The playhead, and the hand-off from one file to the next. `ended` on a segment is
  // not the end of anything the listener can hear, so it becomes a seek instead.
  useEffect(() => {
    const element = audio.current
    if (!element) return
    const onTime = (): void => {
      const segment = segments.find((s) => s.id === loaded)
      if (segment) onPosition(segment.offsetMs + element.currentTime * 1000)
    }
    const onEnded = (): void => {
      const index = segments.findIndex((s) => s.id === loaded)
      const next = segments[index + 1]
      if (next) seek(next.offsetMs, true)
      else setPlaying(false)
    }
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('ended', onEnded)
    return () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('ended', onEnded)
    }
  }, [loaded, onPosition, seek, segments])

  const toggle = (): void => {
    const element = audio.current
    if (!element) return
    if (playing) {
      element.pause()
      setPlaying(false)
      return
    }
    setPlaying(true)
    if (!loaded) seek(positionMs, true)
    else void element.play()
  }

  if (recording.audioDeletedAt) {
    return (
      <div className="hairline flex items-center gap-2.5 rounded-box border border-dashed px-4 py-3 text-[12px] text-base-content/50">
        <Icon name="trash" size={13} className="text-base-content/30" />
        The audio was deleted. The transcript and the recap below are all that is left of it, and
        they are not going anywhere.
      </div>
    )
  }

  if (segments.length === 0) {
    return (
      <div className="hairline rounded-box border border-dashed px-4 py-3 text-[12px] text-base-content/50">
        No audio was captured.
      </div>
    )
  }

  return (
    <div className="hairline rounded-box border bg-base-100 px-4 py-3">
      <audio ref={audio} preload="none" onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />

      <div className="flex items-center gap-3">
        <button className="btn btn-circle btn-sm btn-neutral" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>

        <span className="w-[4.5rem] shrink-0 text-[11.5px] tabular-nums text-base-content/60">
          {formatDuration(positionMs)}
        </span>

        <input
          type="range"
          className="range range-xs flex-1"
          min={0}
          max={Math.max(1, total)}
          step={100}
          value={Math.min(positionMs, total)}
          onChange={(e) => seek(Number(e.target.value), playing)}
        />

        <span className="w-[4.5rem] shrink-0 text-right text-[11.5px] tabular-nums text-base-content/40">
          {formatDuration(total)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-base-content/40">
        <span>{formatBytes(recording.bytes)} on disk</span>
        <span>·</span>
        <span>
          {recording.segments.length} part{recording.segments.length === 1 ? '' : 's'}
        </span>
        <DeleteAudioButton
          recording={recording}
          className="btn btn-ghost btn-xs ml-auto text-base-content/40 hover:text-error"
        />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- transcript */

function Transcript({
  recording,
  cues,
  positionMs,
  onSeek,
  cast
}: {
  recording: RecordingView
  cues: TranscriptCue[]
  positionMs: number
  onSeek: (ms: number) => void
  cast: CastMember[]
}): React.JSX.Element {
  const [follow, setFollow] = useState(true)
  const retry = useApiMutation('recording:retry')
  const container = useRef<HTMLDivElement>(null)

  const active = useMemo(() => {
    let found: string | null = null
    for (const cue of cues) {
      if (cue.startMs <= positionMs) found = cue.id
      else break
    }
    return found
  }, [cues, positionMs])

  useEffect(() => {
    if (!follow || !active) return
    const element = container.current?.querySelector(`[data-cue="${active}"]`)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active, follow])

  // Consecutive lines from one person read as a paragraph, not as a list of
  // fragments, so they are gathered before they are drawn.
  const turns = useMemo(() => {
    const out: { speaker: string; cues: TranscriptCue[] }[] = []
    for (const cue of cues) {
      const last = out[out.length - 1]
      if (last && last.speaker === cue.speaker) last.cues.push(cue)
      else out.push({ speaker: cue.speaker, cues: [cue] })
    }
    return out
  }, [cues])

  if (recording.transcriptState === 'failed' && cues.length === 0) {
    return (
      <EmptyState
        icon="alert"
        title="This recording could not be transcribed."
        hint={recording.transcriptError}
        action={
          <button className="btn btn-sm" onClick={() => retry.mutate({ id: recording.id, step: 'transcript' })}>
            Try again
          </button>
        }
      />
    )
  }

  if (cues.length === 0) {
    return (
      <div className="hairline rounded-box border border-dashed px-4 py-6 text-center text-[12px] text-base-content/45">
        The transcript will appear here as it is written — {recording.transcribed} of{' '}
        {recording.segmentCount} parts so far.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-medium">Transcript</span>
        <span className="text-[11px] text-base-content/35">
          {recording.transcriptEngine === 'local' ? 'Transcribed locally' : 'Transcribed by OpenAI'} ·{' '}
          {recording.transcriptModel}
        </span>
        <button
          className={`btn btn-xs ml-auto gap-1 ${follow ? 'btn-active' : 'btn-ghost'}`}
          onClick={() => setFollow(!follow)}
          aria-pressed={follow}
        >
          <Icon name="arrowRight" size={11} />
          Follow
        </button>
      </div>

      <SpeakerLegend recording={recording} cast={cast} />

      <div ref={container} className="scroll-area max-h-[52vh] space-y-3 pr-1">
        {turns.map((turn, index) => (
          <div key={index}>
            {turn.speaker && (
              <div className="mb-0.5 text-[11px] font-medium text-base-content/50">
                {recording.speakers[turn.speaker]?.name || turn.speaker}
              </div>
            )}
            <p className="text-[13px] leading-relaxed">
              {turn.cues.map((cue) => (
                <span
                  key={cue.id}
                  data-cue={cue.id}
                  onClick={() => onSeek(cue.startMs)}
                  className={`cursor-pointer rounded-[3px] px-px transition ${
                    cue.id === active
                      ? 'bg-primary/15 text-base-content'
                      : 'text-base-content/70 hover:bg-base-content/5'
                  }`}
                  title={formatDuration(cue.startMs)}
                >
                  {cue.text}{' '}
                </span>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Who the speakers are.
 *
 * The labels come out of a language model reading the transcript, not out of the
 * audio — there is no voice-print model on a stock Mac — so the panel says so, and
 * every label can be corrected in a click. The correction is stored against the
 * label rather than written through the lines, so it is one row and it is reversible.
 */
function SpeakerLegend({
  recording,
  cast
}: {
  recording: RecordingView
  cast: CastMember[]
}): React.JSX.Element | null {
  const name = useApiMutation('recording:nameSpeaker')
  const [editing, setEditing] = useState<string | null>(null)
  const labels = Object.keys(recording.speakers).sort()

  if (labels.length === 0) return null

  return (
    <div className="hairline mb-3 rounded-field border bg-base-200/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-base-content/45">Speakers:</span>
        {labels.map((label) => {
          const named = recording.speakers[label]?.name
          return editing === label ? (
            <select
              key={label}
              autoFocus
              className="select select-bordered select-xs"
              defaultValue={recording.speakers[label]?.personId ?? ''}
              onBlur={() => setEditing(null)}
              onChange={(e) => {
                const person = cast.find((c) => c.personId === e.target.value)
                name.mutate({
                  id: recording.id,
                  label,
                  name: person?.name ?? '',
                  personId: person?.personId ?? null
                })
                setEditing(null)
              }}
            >
              <option value="">{label} (unnamed)</option>
              {cast.map((member) => (
                <option key={member.personId} value={member.personId}>
                  {member.name}
                </option>
              ))}
            </select>
          ) : (
            <button
              key={label}
              className="hairline rounded-full border px-2 py-px text-[11px] transition hover:bg-base-content/5"
              onClick={() => setEditing(label)}
              title="Put a name to this voice"
            >
              {named || label}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-base-content/40">
        Speakers are worked out from the words, not from the voices, so the turns are a good guess
        rather than a measurement. Click one to put a real name to it.
      </p>
    </div>
  )
}
