import { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import {
  HEARTBEAT_DEAD_MS, MAX_ATTEMPTS, backoffMs, hasTimestamps, speakerLabel
} from '@shared/recording'
import type { Recap, RecordingEvent, SpeakerName } from '@shared/types'
import { exec, q, q1 } from '../../db/client'
import { invokeChannel, removeWhere, updateWhere, upsert } from '../../ipc/util'
import { logActivity } from '../activity'
import { mirrorProject } from '../markdown'
import { segmentPath } from './store'
import {
  describeEngineError, isPermanent, recapEngine, transcribeEngine, workspaceOfRecording
} from './engine'
import { transcribeSegment } from './transcribe'
import { attributeSpeakers, summarisePart, writeRecap, type RecapContext } from './summarise'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The part that has to survive the machine going away.
 *
 * Everything a recording is waiting for is a row, and every row says which step it
 * reached, how many goes it has had at it and when it may next be tried. There is no
 * queue in memory, no timer holding the only copy of a retry, and no promise chain
 * that a crash could break in the middle — the runner below reads the rows, does
 * exactly one unit of work, writes the result down, and looks again.
 *
 * That is what makes recovery uninteresting, which is the point: after a power cut
 * the next launch calls `recoverRecordings()`, which turns "we were in the middle of
 * this" back into "this is waiting", and the runner picks it up having lost at most
 * the one segment or one slice that was in flight. There is nothing to reconstruct,
 * because nothing was ever only in memory.
 *
 * A unit of work is deliberately small — one five-minute segment transcribed, one
 * batch of lines attributed, one slice of a long meeting read — so that the amount
 * of work a crash can cost is bounded by the same number that bounds the audio it
 * can cost.
 */

/** Lines attributed in one go. Small enough that losing one is nothing. */
const SPEAKER_BATCH = 120

/**
 * How much transcript goes into a single recap pass. Roughly 12k tokens of text,
 * which every model here reads comfortably; anything longer is read in slices and
 * the slices are read together at the end.
 */
const PART_CHARS = 48_000

/** A stop on the runner looping, in case a step ever stops making progress. */
const MAX_STEPS_PER_PASS = 500

/* ------------------------------------------------------------------ plumbing */

function broadcast(event: RecordingEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('recording', event)
  }
}

export async function announce(recordingId: string): Promise<void> {
  const row = await q1<{ meeting_id: string }>('SELECT meeting_id FROM recording WHERE id = $1', [
    recordingId
  ])
  if (row) broadcast({ type: 'changed', recordingId, meetingId: row.meeting_id })
}

/**
 * Where a recording is on the timeline. Offsets are recomputed rather than
 * accumulated, so a segment whose length was corrected — the last one before an
 * interruption, whose duration was a wall-clock guess until capture stopped — moves
 * everything after it into the right place instead of leaving a growing skew.
 */
export async function recomputeTimeline(recordingId: string): Promise<void> {
  await exec(
    `UPDATE recording_segment s SET offset_ms = x.off
     FROM (
       SELECT id,
              COALESCE(SUM(duration_ms) OVER (
                ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ), 0) AS off
       FROM recording_segment WHERE recording_id = $1
     ) x
     WHERE s.id = x.id AND s.offset_ms IS DISTINCT FROM x.off`,
    [recordingId]
  )
  // The segment offsets above are this machine's bookkeeping. The two totals below
  // are facts about the recording, so they go through the log like anything else.
  const totals = await q1<{ duration: string; bytes: string }>(
    `SELECT COALESCE(SUM(duration_ms), 0) AS duration,
            COALESCE(SUM(bytes) FILTER (WHERE path <> ''), 0) AS bytes
       FROM recording_segment WHERE recording_id = $1`,
    [recordingId]
  )
  await upsert('recording', {
    durationMs: Number(totals?.duration ?? 0),
    bytes: Number(totals?.bytes ?? 0)
  }, recordingId)
}

/* ------------------------------------------------------------------ recovery */

/**
 * Turn "in progress" back into "waiting", once, at startup.
 *
 * Every `running` in the database was being run by a process that no longer exists,
 * so it is not running. A capture that was live is `interrupted` rather than
 * `stopped`, because the audio it holds may be half of a meeting that is still going
 * on in the room — only the person in that room knows whether to resume it or write
 * it up, and guessing either way is worse than asking.
 */
export async function recoverRecordings(): Promise<number> {
  const live = await q<{ id: string }>(
    `UPDATE recording SET capture_state = 'interrupted', updated_at = now()
     WHERE capture_state = 'recording' RETURNING id`
  )
  await exec(`UPDATE recording_segment SET state = 'pending' WHERE state = 'running'`)
  await exec(`UPDATE summary_part SET state = 'pending' WHERE state = 'running'`)
  await exec(
    `UPDATE recording
     SET transcript_state = CASE WHEN transcript_state = 'running' THEN 'pending' ELSE transcript_state END,
         speaker_state    = CASE WHEN speaker_state    = 'running' THEN 'pending' ELSE speaker_state END,
         summary_state    = CASE WHEN summary_state    = 'running' THEN 'pending' ELSE summary_state END,
         next_attempt_at  = NULL
     WHERE 'running' IN (transcript_state, speaker_state, summary_state)`
  )
  for (const row of live) await recomputeTimeline(row.id)
  return live.length
}

/**
 * A renderer can die without the app dying — a reload, a crashed window, a tab that
 * was never told the machine was going to sleep. The heartbeat is what notices, and
 * it is checked in main because main is the process that is still there.
 */
export async function reapDeadCaptures(): Promise<void> {
  const dead = await q<{ id: string; meeting_id: string }>(
    `UPDATE recording SET capture_state = 'interrupted', updated_at = now()
     WHERE capture_state = 'recording'
       AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id, meeting_id`,
    [String(HEARTBEAT_DEAD_MS)]
  )
  for (const row of dead) {
    await recomputeTimeline(row.id)
    broadcast({ type: 'interrupted', recordingId: row.id, meetingId: row.meeting_id })
  }
}

/* -------------------------------------------------------------------- runner */

let running = false
let again = false
let timer: NodeJS.Timeout | null = null

/** Ask the runner to look again. Safe to call from anywhere, as often as you like. */
export function kick(): void {
  if (running) {
    again = true
    return
  }
  void drain()
}

async function drain(): Promise<void> {
  running = true
  try {
    do {
      again = false
      // Each pass does one unit of work and writes it down. Looping until there is
      // nothing left means a backlog of six meetings after a week away clears itself
      // without anybody pressing anything.
      //
      // The cap is not expected to be reached — every step either finishes something
      // or writes down why it could not — but a runner that can spin is a runner
      // that will eventually spin, and a laptop with a hot fan and no explanation is
      // a worse failure than a backlog that waits fifteen seconds for the next tick.
      let steps = 0
      while (await step()) {
        if (++steps < MAX_STEPS_PER_PASS) continue
        console.warn('The recording pipeline hit its step limit; pausing until the next tick.')
        return
      }
    } while (again)
  } catch (error) {
    console.error('The recording pipeline stopped unexpectedly:', error)
  } finally {
    running = false
  }
}

export function startPipeline(): void {
  if (timer) return
  // Backoff is a timestamp in a row rather than a timer, so all a tick has to do is
  // look; nothing is lost if the process misses one, or a thousand.
  timer = setInterval(() => {
    void reapDeadCaptures().then(kick).catch(() => {})
  }, 15_000)
  timer.unref?.()
  kick()
}

export function stopPipeline(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** The next recording with something to do, honouring its own backoff. */
async function nextRecording(): Promise<any | null> {
  return q1<any>(
    `SELECT * FROM recording
     WHERE capture_state = 'stopped'
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       AND (
         transcript_state IN ('pending', 'running')
         OR (transcript_state = 'done' AND speaker_state IN ('pending', 'running'))
         OR (transcript_state = 'done' AND speaker_state IN ('done', 'failed')
             AND summary_state IN ('pending', 'running'))
         OR (summary_state = 'done'
             AND (recap_written_at IS NULL OR recap_todos_at IS NULL))
       )
     ORDER BY stopped_at NULLS LAST, created_at
     LIMIT 1`
  )
}

/** True when it did something, so the caller knows to look again immediately. */
async function step(): Promise<boolean> {
  const recording = await nextRecording()
  if (!recording) return false

  try {
    // Folding a finished recap into its meeting is a step like any other rather than
    // something `storeRecap` does on its way past. That is what makes it recoverable:
    // a recap written by a build that could not do this, or one whose meeting was
    // busy, is simply a row the runner finds waiting the next time it looks.
    if (
      recording.summary_state === 'done' &&
      (!recording.recap_written_at || !recording.recap_todos_at)
    ) {
      await applyStep(recording)
    } else if (recording.transcript_state !== 'done') await transcribeStep(recording)
    else if (['pending', 'running'].includes(recording.speaker_state)) await speakerStep(recording)
    else await summaryStep(recording)
  } catch (error) {
    // A failure that got this far is a bug rather than a service being down, and it
    // must not put the runner into a spin over the same row.
    console.error('Recording step failed:', error)
    await exec(
      `UPDATE recording SET next_attempt_at = now() + interval '60 seconds', updated_at = now()
       WHERE id = $1`,
      [recording.id]
    )
  }
  await announce(recording.id)
  return true
}

/**
 * What happens to a step that just failed. A wrong key or a model that does not
 * exist will fail again in five minutes, so those stop and say so; a refused
 * connection to a local server that has not been started yet is exactly the thing
 * worth waiting for, so those back off and come round again.
 */
async function fail(
  recordingId: string,
  column: 'transcript' | 'speaker' | 'summary',
  attempts: number,
  error: unknown,
  message: string
): Promise<void> {
  const permanent = isPermanent(error)
  const exhausted = attempts >= MAX_ATTEMPTS
  if (permanent || exhausted) {
    await exec(
      `UPDATE recording SET ${column}_state = 'failed', ${column}_error = $2,
              next_attempt_at = NULL, updated_at = now()
       WHERE id = $1`,
      [recordingId, message]
    )
    return
  }
  await exec(
    `UPDATE recording SET ${column}_state = 'pending', ${column}_error = $2,
            next_attempt_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
     WHERE id = $1`,
    [recordingId, message, String(backoffMs(attempts))]
  )
}

/* --------------------------------------------------------------- transcribing */

async function transcribeStep(recording: any): Promise<void> {
  if (recording.audio_deleted_at) {
    await exec(
      `UPDATE recording SET transcript_state = 'failed',
              transcript_error = 'The audio was deleted before it had been transcribed.',
              updated_at = now() WHERE id = $1`,
      [recording.id]
    )
    return
  }

  const segment = await q1<any>(
    `SELECT * FROM recording_segment
     WHERE recording_id = $1 AND state IN ('pending', 'running') AND attempts < $2
     ORDER BY ord LIMIT 1`,
    [recording.id, MAX_ATTEMPTS]
  )

  if (!segment) {
    await finishTranscript(recording.id)
    return
  }

  const workspace = await workspaceOfRecording(recording.id)
  let config
  try {
    config = transcribeEngine(workspace)
  } catch (error) {
    await fail(recording.id, 'transcript', MAX_ATTEMPTS, error, (error as Error).message)
    return
  }

  await upsert('recording', {
    transcriptState: 'running',
    transcriptEngine: config.engine,
    transcriptModel: config.model,
    transcriptError: '',
    updatedAt: new Date()
  }, recording.id)
  await exec(`UPDATE recording_segment SET state = 'running' WHERE id = $1`, [segment.id])

  let audio: Buffer
  try {
    audio = segment.path ? await readFile(segmentPath(recording.id, segment.path)) : Buffer.alloc(0)
  } catch {
    audio = Buffer.alloc(0)
  }

  // A segment with nothing in it is not a failure to retry — it is a capture that
  // was cut off before any audio reached it. Mark it read and move on.
  if (audio.byteLength === 0) {
    await exec(
      `UPDATE recording_segment SET state = 'done', error = '' WHERE id = $1`,
      [segment.id]
    )
    return
  }

  try {
    const cues = await transcribeSegment(
      config,
      audio,
      segment.path || 'segment.webm',
      Number(segment.duration_ms ?? 0)
    )
    const offset = Number(segment.offset_ms ?? 0)
    const start = await nextCueOrd(recording.id)

    // Written in one statement so that a crash leaves either all of this segment's
    // words or none of them — never half a segment that would then be transcribed
    // again and appear twice.
    await removeWhere('transcript_cue', { segmentId: segment.id })
    for (const [index, cue] of cues.entries()) {
      await upsert('transcript_cue', {
        recordingId: recording.id,
        segmentId: segment.id,
        ord: start + index,
        startMs: offset + cue.startMs,
        endMs: offset + cue.endMs,
        text: cue.text
      })
    }
    await exec(`UPDATE recording_segment SET state = 'done', error = '' WHERE id = $1`, [segment.id])
    await exec(
      `UPDATE recording SET transcript_error = '', next_attempt_at = NULL, updated_at = now()
       WHERE id = $1`,
      [recording.id]
    )
  } catch (error) {
    const message = describeEngineError(error, config)
    const attempts = Number(segment.attempts ?? 0) + 1
    const done = isPermanent(error) || attempts >= MAX_ATTEMPTS
    await exec(
      `UPDATE recording_segment SET state = $2, attempts = $3, error = $4 WHERE id = $1`,
      [segment.id, done ? 'failed' : 'pending', attempts, message]
    )
    await fail(recording.id, 'transcript', attempts, error, message)
  }
}

async function nextCueOrd(recordingId: string): Promise<number> {
  const row = await q1<{ n: number }>(
    'SELECT COALESCE(max(ord), -1) + 1 AS n FROM transcript_cue WHERE recording_id = $1',
    [recordingId]
  )
  return Number(row?.n ?? 0)
}

/**
 * Transcription is over when no segment is still waiting.
 *
 * A segment that could not be transcribed does not condemn the rest: five minutes of
 * a two-hour meeting missing is a gap you can see and work around, and holding the
 * recap back over it would lose the other hour and fifty-five as well. Only a
 * recording where nothing at all came through counts as failed.
 */
async function finishTranscript(recordingId: string): Promise<void> {
  const counts = await q1<{ total: number; failed: number; cues: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state <> 'done')::int AS failed,
            (SELECT count(*)::int FROM transcript_cue WHERE recording_id = $1) AS cues
     FROM recording_segment WHERE recording_id = $1`,
    [recordingId]
  )
  const failed = Number(counts?.failed ?? 0)
  const cues = Number(counts?.cues ?? 0)

  if (cues === 0) {
    const worst = await q1<{ error: string }>(
      `SELECT error FROM recording_segment WHERE recording_id = $1 AND error <> '' ORDER BY ord LIMIT 1`,
      [recordingId]
    )
    await exec(
      `UPDATE recording SET transcript_state = 'failed', transcript_error = $2, updated_at = now()
       WHERE id = $1`,
      [recordingId, worst?.error || 'Nothing could be transcribed from this recording.']
    )
    return
  }

  await exec(
    `UPDATE recording
     SET transcript_state = 'done', transcribed_at = now(), next_attempt_at = NULL,
         transcript_error = CASE WHEN $2 > 0
           THEN $2 || ' part(s) of this recording could not be transcribed.' ELSE '' END,
         updated_at = now()
     WHERE id = $1`,
    [recordingId, failed]
  )
}

/* ------------------------------------------------------------------ speakers */

async function speakerStep(recording: any): Promise<void> {
  // Nothing to attribute when the model returned no times: the whole segment is one
  // line, and labelling it would be inventing a conversation that was not measured.
  if (!hasTimestamps(recording.transcript_model ?? '')) {
    await exec(`UPDATE recording SET speaker_state = 'done', updated_at = now() WHERE id = $1`, [
      recording.id
    ])
    return
  }

  const batch = await q<any>(
    `SELECT ord, start_ms, text FROM transcript_cue
     WHERE recording_id = $1 AND speaker = '' ORDER BY ord LIMIT $2`,
    [recording.id, SPEAKER_BATCH]
  )
  if (batch.length === 0) {
    await exec(
      `UPDATE recording SET speaker_state = 'done', speaker_error = '', next_attempt_at = NULL,
              updated_at = now() WHERE id = $1`,
      [recording.id]
    )
    return
  }

  const workspace = await workspaceOfRecording(recording.id)
  let config
  try {
    config = recapEngine(workspace)
  } catch (error) {
    await fail(recording.id, 'speaker', MAX_ATTEMPTS, error, (error as Error).message)
    return
  }

  await exec(
    `UPDATE recording SET speaker_state = 'running', updated_at = now() WHERE id = $1`,
    [recording.id]
  )

  const attendees = await attendeeNames(recording.meeting_id)
  const known = await q<{ speaker: string }>(
    `SELECT DISTINCT speaker FROM transcript_cue
     WHERE recording_id = $1 AND speaker <> '' ORDER BY speaker`,
    [recording.id]
  )

  const attempts = Number(recording.speaker_attempts ?? 0) + 1
  try {
    const assigned = await attributeSpeakers(
      config,
      batch.map((c) => ({ ord: Number(c.ord), startMs: Number(c.start_ms), text: c.text })),
      attendees,
      known.map((k) => k.speaker)
    )

    // Every line in the batch gets a speaker, whether or not the model named it —
    // otherwise the batch comes back forever and the step never ends.
    const fallback = known[0]?.speaker || speakerLabel(0)
    let previous = fallback
    for (const cue of batch) {
      const speaker = assigned[Number(cue.ord)] || previous
      previous = speaker
      await updateWhere('transcript_cue', { recordingId: recording.id, ord: Number(cue.ord) }, { speaker })
    }

    await refreshSpeakerIndex(recording.id)
    await exec(
      `UPDATE recording SET speaker_error = '', speaker_attempts = 0, next_attempt_at = NULL,
              updated_at = now() WHERE id = $1`,
      [recording.id]
    )
  } catch (error) {
    await exec(`UPDATE recording SET speaker_attempts = $2 WHERE id = $1`, [recording.id, attempts])
    await fail(recording.id, 'speaker', attempts, error, describeEngineError(error, config))
  }
}

/** The set of speakers, kept beside the cues so renaming one is a single write. */
async function refreshSpeakerIndex(recordingId: string): Promise<void> {
  const row = await q1<{ speakers: any }>('SELECT speakers FROM recording WHERE id = $1', [
    recordingId
  ])
  const existing: Record<string, SpeakerName> =
    typeof row?.speakers === 'string' ? JSON.parse(row.speakers) : (row?.speakers ?? {})

  const labels = await q<{ speaker: string }>(
    `SELECT DISTINCT speaker FROM transcript_cue WHERE recording_id = $1 AND speaker <> ''`,
    [recordingId]
  )
  const next: Record<string, SpeakerName> = {}
  for (const { speaker } of labels) {
    next[speaker] = existing[speaker] ?? { name: '', personId: null }
  }
  await upsert('recording', { speakers: JSON.stringify(next) }, recordingId)
}

async function attendeeNames(meetingId: string): Promise<string[]> {
  const rows = await q<{ name: string }>(
    `SELECT p.name FROM meeting_attendee ma JOIN person p ON p.id = ma.person_id
     WHERE ma.meeting_id = $1 ORDER BY p.name`,
    [meetingId]
  )
  return rows.map((r) => r.name)
}

/* --------------------------------------------------------------------- recap */

async function recapContext(recording: any, prompt: string): Promise<RecapContext> {
  const row = await q1<any>(
    `SELECT m.title, m.occurred_on, p.name AS project_name, p.id AS project_id
     FROM meeting m JOIN project p ON p.id = m.project_id WHERE m.id = $1`,
    [recording.meeting_id]
  )
  return {
    meetingTitle: row?.title ?? '',
    occurredOn: row?.occurred_on ?? '',
    projectName: row?.project_name ?? '',
    attendees: await attendeeNames(recording.meeting_id),
    prompt
  }
}

/** The transcript as the model reads it: one line per turn, the speaker in front. */
async function transcriptText(recordingId: string, fromOrd = 0, toOrd = Number.MAX_SAFE_INTEGER): Promise<string> {
  const cues = await q<{ speaker: string; text: string }>(
    `SELECT speaker, text FROM transcript_cue
     WHERE recording_id = $1 AND ord >= $2 AND ord <= $3 ORDER BY ord`,
    [recordingId, fromOrd, Math.min(toOrd, 2_000_000_000)]
  )
  const lines: string[] = []
  let speaker = ''
  for (const cue of cues) {
    if (cue.speaker && cue.speaker !== speaker) {
      speaker = cue.speaker
      lines.push(`\n${speaker}: ${cue.text}`)
    } else {
      lines.push(cue.text)
    }
  }
  return lines.join(' ').replace(/\n /g, '\n').trim()
}

async function summaryStep(recording: any): Promise<void> {
  const workspace = await workspaceOfRecording(recording.id)
  let config
  try {
    config = recapEngine(workspace)
  } catch (error) {
    await fail(recording.id, 'summary', MAX_ATTEMPTS, error, (error as Error).message)
    return
  }

  await exec(
    `UPDATE recording SET summary_state = 'running', summary_engine = $2, summary_model = $3,
            updated_at = now() WHERE id = $1`,
    [recording.id, config.engine, config.model]
  )

  const context = await recapContext(recording, workspace.recap_prompt ?? '')
  const attempts = Number(recording.summary_attempts ?? 0) + 1

  try {
    const whole = await transcriptText(recording.id)
    if (!whole) {
      await exec(
        `UPDATE recording SET summary_state = 'failed',
                summary_error = 'There is nothing in the transcript to write up.', updated_at = now()
         WHERE id = $1`,
        [recording.id]
      )
      return
    }

    // Short enough to read in one go, which is always the better answer: a single
    // pass sees the whole arc of the meeting, including the decision that was taken
    // early and quietly undone at the end.
    if (whole.length <= PART_CHARS) {
      const written = await writeRecap(config, context, whole, false)
      await storeRecap(recording, written)
      return
    }

    // Too long. Slice it once, then work through the slices one per pass, writing
    // each down — so a machine that dies two thirds of the way through a two-hour
    // meeting resumes at slice nine rather than at slice one.
    await ensureParts(recording.id)
    const part = await q1<any>(
      `SELECT * FROM summary_part
       WHERE recording_id = $1 AND state IN ('pending', 'running') AND attempts < $2
       ORDER BY ord LIMIT 1`,
      [recording.id, MAX_ATTEMPTS]
    )
    const total = await q1<{ n: number }>(
      'SELECT count(*)::int AS n FROM summary_part WHERE recording_id = $1',
      [recording.id]
    )

    if (part) {
      await exec(`UPDATE summary_part SET state = 'running' WHERE id = $1`, [part.id])
      try {
        const slice = await transcriptText(recording.id, Number(part.from_cue), Number(part.to_cue))
        const notes = await summarisePart(
          config, context, slice, Number(part.ord) + 1, Number(total?.n ?? 1)
        )
        await exec(
          `UPDATE summary_part SET state = 'done', notes = $2, error = '' WHERE id = $1`,
          [part.id, notes]
        )
        await exec(
          `UPDATE recording SET summary_state = 'pending', summary_error = '',
                  next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
          [recording.id]
        )
      } catch (error) {
        const partAttempts = Number(part.attempts ?? 0) + 1
        const stop = isPermanent(error) || partAttempts >= MAX_ATTEMPTS
        await exec(
          `UPDATE summary_part SET state = $2, attempts = $3, error = $4 WHERE id = $1`,
          [part.id, stop ? 'failed' : 'pending', partAttempts, describeEngineError(error, config)]
        )
        await fail(recording.id, 'summary', partAttempts, error, describeEngineError(error, config))
      }
      return
    }

    // Every slice has been read; now read them together.
    const notes = await q<{ ord: number; notes: string }>(
      `SELECT ord, notes FROM summary_part WHERE recording_id = $1 AND state = 'done' ORDER BY ord`,
      [recording.id]
    )
    if (notes.length === 0) {
      await exec(
        `UPDATE recording SET summary_state = 'failed',
                summary_error = 'None of this meeting could be read.', updated_at = now()
         WHERE id = $1`,
        [recording.id]
      )
      return
    }
    const combined = notes
      .map((n) => `## Part ${Number(n.ord) + 1}\n${n.notes}`)
      .join('\n\n')
    await storeRecap(recording, await writeRecap(config, context, combined, true))
  } catch (error) {
    await exec(`UPDATE recording SET summary_attempts = $2 WHERE id = $1`, [recording.id, attempts])
    await fail(recording.id, 'summary', attempts, error, describeEngineError(error, config))
  }
}

/**
 * The recap becomes part of the meeting.
 *
 * Written into the write-up, used to name a meeting nobody named, and turned into a
 * to-do item for every commitment somebody made out loud — all through the ordinary
 * channels, so what arrives behaves exactly as if it had been typed. A recap that
 * sits behind a button on a second screen is a recap nobody reads.
 */
async function applyStep(recording: any): Promise<void> {
  try {
    await invokeChannel('recording:applyRecap', { id: recording.id })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // An empty recap will still be empty in five minutes, so stop rather than spin.
    if (/no recap to fold in/i.test(message)) {
      await upsert('recording', {
        recapWrittenAt: new Date(),
        recapTodosAt: new Date(),
        updatedAt: new Date()
      }, recording.id)
      return
    }
    console.error('Could not fold the recap into the meeting:', error)
    await exec(
      `UPDATE recording SET next_attempt_at = now() + interval '5 minutes', updated_at = now()
       WHERE id = $1`,
      [recording.id]
    )
  }
}

async function ensureParts(recordingId: string): Promise<void> {
  const existing = await q1<{ n: number }>(
    'SELECT count(*)::int AS n FROM summary_part WHERE recording_id = $1',
    [recordingId]
  )
  if (Number(existing?.n ?? 0) > 0) return

  const cues = await q<{ ord: number; text: string }>(
    'SELECT ord, text FROM transcript_cue WHERE recording_id = $1 ORDER BY ord',
    [recordingId]
  )
  let from = cues[0] ? Number(cues[0].ord) : 0
  let size = 0
  let ord = 0
  for (const [index, cue] of cues.entries()) {
    size += cue.text.length + 1
    const last = index === cues.length - 1
    if (size < PART_CHARS && !last) continue
    await exec(
      `INSERT INTO summary_part (recording_id, ord, from_cue, to_cue) VALUES ($1, $2, $3, $4)
       ON CONFLICT (recording_id, ord) DO NOTHING`,
      [recordingId, ord, from, Number(cue.ord)]
    )
    ord += 1
    from = Number(cue.ord) + 1
    size = 0
  }
}

async function storeRecap(
  recording: any,
  written: { title: string; summary: string; recap: Recap }
): Promise<void> {
  await upsert('recording', {
    summaryState: 'done',
    summary: written.summary,
    recap: JSON.stringify(written.recap),
    suggestedTitle: written.title,
    summaryError: '',
    summarisedAt: new Date(),
    nextAttemptAt: null,
    updatedAt: new Date()
  }, recording.id)

  const meeting = await q1<{ project_id: string; title: string; occurred_on: string }>(
    `SELECT m.project_id, m.title, m.occurred_on FROM meeting m WHERE m.id = $1`,
    [recording.meeting_id]
  )
  if (!meeting) return
  await logActivity(
    meeting.project_id,
    'meeting',
    `Recap ready: ${meeting.title || meeting.occurred_on}`,
    recording.meeting_id
  )
  await mirrorProject(meeting.project_id)
}

