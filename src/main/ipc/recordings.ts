import { systemPreferences } from 'electron'
import type { MeetingView, Recap, RecordingView, SpeakerName } from '@shared/types'
import { EMPTY_RECAP } from '@shared/types'
import { CHUNK_MS } from '@shared/recording'
import { exec, q, q1 } from '../db/client'
import { mapCue, mapRecording, mapSegment } from '../db/map'
import { logActivity } from '../lib/activity'
import { meetingViews } from '../db/queries'
import { mirrorProject } from '../lib/markdown'
import { announce, kick, recomputeTimeline } from '../lib/recording/pipeline'
import { commitmentLine, recapMarkdown } from '../lib/recording/summarise'
import { appendChunk, deleteAudio, openSegmentFile, segmentBytes, segmentFile } from '../lib/recording/store'
import {
  startSystemAudio, stopSystemAudio, systemAudioAvailable, testSystemAudio
} from '../lib/recording/systemAudio'
import { handle, invokeChannel, remove, updateWhere, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Recording a meeting, from this side of the bridge.
 *
 * The division of labour is the whole design. Only a renderer can open a microphone,
 * so the renderer holds it — but it holds nothing else: every second of audio is
 * handed straight over and written to disk before the call it arrived on resolves,
 * and every fact about the recording is a row here. A renderer that dies loses the
 * microphone and nothing more; main notices its heartbeat stop and marks the capture
 * interrupted, with all of the audio still on disk and the transcript still to come.
 */

async function view(id: string): Promise<RecordingView> {
  const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
  if (!row) throw new Error('That recording is no longer here.')
  const segments = await q<any>(
    'SELECT * FROM recording_segment WHERE recording_id = $1 ORDER BY ord',
    [id]
  )
  return mapRecording(row, segments.map(mapSegment))
}

/** The meeting as every other screen sees it, without logging a save that did nothing. */
async function meetingView(id: string): Promise<MeetingView> {
  const [meeting] = await meetingViews('m.id = $1', [id])
  if (!meeting) throw new Error('That meeting is no longer here.')
  return meeting
}

async function meetingOf(recordingId: string): Promise<{ meetingId: string; projectId: string }> {
  const row = await q1<any>(
    `SELECT r.meeting_id, m.project_id FROM recording r
     JOIN meeting m ON m.id = r.meeting_id WHERE r.id = $1`,
    [recordingId]
  )
  if (!row) throw new Error('That recording is no longer here.')
  return { meetingId: row.meeting_id, projectId: row.project_id }
}

/** Nothing may be thrown away or rewritten while the microphone is still open. */
async function requireIdle(id: string): Promise<any> {
  const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
  if (!row) throw new Error('That recording is no longer here.')
  if (row.capture_state === 'recording') {
    throw new Error('This meeting is still being recorded. Stop the recording first.')
  }
  return row
}

export function registerRecordingHandlers(): void {
  handle('recording:start', async ({ meetingId }) => {
    const meeting = await q1<any>('SELECT id, project_id, title, occurred_on FROM meeting WHERE id = $1', [
      meetingId
    ])
    if (!meeting) throw new Error('That meeting is no longer here.')

    // One recording per meeting, so pressing record twice picks the same one back up
    // rather than opening a second microphone into the same room. A recording that
    // has already been stopped is finished with — recording over it would throw away
    // a transcript, so it has to be deleted deliberately first.
    const existing = await q1<any>('SELECT * FROM recording WHERE meeting_id = $1', [meetingId])
    if (existing) {
      if (existing.capture_state === 'stopped') {
        throw new Error(
          'This meeting already has a recording. Delete it first if you want to record again.'
        )
      }
      await exec(
        `UPDATE recording SET capture_state = 'recording', heartbeat_at = now(), stopped_at = NULL,
                updated_at = now() WHERE id = $1`,
        [existing.id]
      )
      return view(existing.id)
    }

    const row = await upsert<any>('recording', { meetingId })
    await logActivity(
      meeting.project_id,
      'meeting',
      `Started recording: ${meeting.title || meeting.occurred_on}`,
      meetingId
    )
    return view(row!.id)
  })

  handle('recording:resume', async ({ id }) => {
    const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
    if (!row) throw new Error('That recording is no longer here.')
    if (row.audio_deleted_at) throw new Error('This recording’s audio has been deleted.')
    // Everything captured before the interruption stays exactly where it is; the new
    // sound arrives as further segments after it.
    // The pipeline columns here are device-only and are filtered out of the op; only
    // `stopped_at` travels, which is the one fact about the recording rather than
    // about this machine's runner.
    await upsert('recording', {
      captureState: 'recording',
      heartbeatAt: new Date(),
      stoppedAt: null,
      transcriptState: 'pending',
      transcriptError: '',
      speakerState: 'pending',
      summaryState: 'pending',
      nextAttemptAt: null,
      updatedAt: new Date()
    }, id)
    return view(id)
  })

  handle('recording:openSegment', async ({ id }) => {
    const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
    if (!row) throw new Error('That recording is no longer here.')
    if (row.capture_state !== 'recording') throw new Error('This recording is not running.')

    const max = await q1<{ n: number }>(
      'SELECT COALESCE(max(ord), -1) + 1 AS n FROM recording_segment WHERE recording_id = $1',
      [id]
    )
    const ord = Number(max?.n ?? 0)
    const file = segmentFile(ord)
    // The file exists before the row does, so a row can never name a file that is not
    // there — the other way round leaves at worst an empty file nobody refers to.
    await openSegmentFile(id, file)
    const segment = await upsert<{ id: string }>('recording_segment', {
      recordingId: id, ord, path: file
    })
    return { segmentId: segment.id, ord }
  })

  handle('recording:appendChunk', async ({ segmentId, data }) => {
    const row = await q1<any>(
      `SELECT s.*, r.capture_state, r.audio_deleted_at FROM recording_segment s
       JOIN recording r ON r.id = s.recording_id WHERE s.id = $1`,
      [segmentId]
    )
    if (!row) throw new Error('That segment is no longer here.')
    if (row.closed || !row.path || row.audio_deleted_at) return { bytes: Number(row.bytes ?? 0) }

    const bytes = await appendChunk(row.recording_id, row.path, Buffer.from(data, 'base64'))
    // The duration is kept up to date on the way in as well as at the end, because a
    // segment that is interrupted never gets an end — and a recording whose last five
    // minutes had no length would put every later segment in the wrong place on the
    // timeline. The wall clock is only an estimate; closing the segment corrects it.
    // Computed here rather than in the statement: `now()` is evaluated by whichever
    // database runs it, so a replay would measure the segment against the day of the
    // replay instead of the afternoon it was recorded.
    const elapsed = Date.now() - new Date(String(row.created_at)).getTime() - CHUNK_MS
    await upsert('recording_segment', {
      bytes,
      durationMs: Math.max(Number(row.duration_ms ?? 0), Math.max(0, Math.round(elapsed)))
    }, segmentId)
    return { bytes }
  })

  handle('recording:closeSegment', async ({ segmentId, durationMs }) => {
    const row = await q1<any>('SELECT * FROM recording_segment WHERE id = $1', [segmentId])
    if (!row || row.closed) return
    const bytes = row.path ? await segmentBytes(row.recording_id, row.path) : 0
    await upsert(
      'recording_segment',
      { closed: true, bytes, durationMs: Math.max(0, Math.round(durationMs)) },
      segmentId
    )
    await recomputeTimeline(row.recording_id)
  })

  handle('recording:heartbeat', async ({ id, durationMs }) => {
    const live = await q1<{ duration_ms: string }>(
      `SELECT duration_ms FROM recording WHERE id = $1 AND capture_state = 'recording'`,
      [id]
    )
    if (!live) return
    await upsert('recording', {
      heartbeatAt: new Date(),
      durationMs: Math.max(Number(live.duration_ms ?? 0), Math.max(0, Math.round(durationMs)))
    }, id)
  })

  handle('recording:stop', async ({ id, durationMs }) => {
    const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
    if (!row) throw new Error('That recording is no longer here.')

    // Anything still open is closed with the length it had reached. A segment left
    // open by a renderer that went away mid-sentence still has a duration, because
    // every appended chunk kept it roughly current.
    const open = await q<any>(
      `SELECT * FROM recording_segment WHERE recording_id = $1 AND closed = false`,
      [id]
    )
    for (const segment of open) {
      const bytes = segment.path ? await segmentBytes(id, segment.path) : 0
      await upsert('recording_segment', { closed: true, bytes }, segment.id)
    }

    await upsert('recording', {
      captureState: 'stopped',
      stoppedAt: new Date(),
      durationMs: Math.max(Number(row.duration_ms ?? 0), Math.max(0, Math.round(durationMs))),
      updatedAt: new Date()
    }, id)
    await recomputeTimeline(id)

    const { meetingId, projectId } = await meetingOf(id)
    const meeting = await q1<any>('SELECT title, occurred_on FROM meeting WHERE id = $1', [meetingId])
    await logActivity(
      projectId,
      'meeting',
      `Recording finished: ${meeting?.title || meeting?.occurred_on}`,
      meetingId
    )
    // Transcription starts on its own from here. Nothing else has to be pressed, and
    // nothing about it depends on this window staying open.
    kick()
    return view(id)
  })

  handle('recording:get', async ({ meetingId }) => {
    const row = await q1<any>('SELECT * FROM recording WHERE meeting_id = $1', [meetingId])
    if (!row) return { recording: null, cues: [] }
    const segments = await q<any>(
      'SELECT * FROM recording_segment WHERE recording_id = $1 ORDER BY ord',
      [row.id]
    )
    const cues = await q<any>(
      'SELECT * FROM transcript_cue WHERE recording_id = $1 ORDER BY ord',
      [row.id]
    )
    return {
      recording: mapRecording(row, segments.map(mapSegment)),
      cues: cues.map(mapCue)
    }
  })

  handle('recording:retry', async ({ id, step }) => {
    await requireIdle(id)
    if (step === 'transcript') {
      await exec(
        `UPDATE recording_segment SET state = 'pending', attempts = 0, error = ''
         WHERE recording_id = $1 AND state <> 'done'`,
        [id]
      )
      // The later steps read the transcript, so a transcript that is about to change
      // takes them back to the start with it.
      await exec('DELETE FROM summary_part WHERE recording_id = $1', [id])
      await exec(
        `UPDATE recording SET transcript_state = 'pending', transcript_error = '',
                transcript_attempts = 0, speaker_state = 'pending', speaker_attempts = 0,
                summary_state = 'pending', summary_attempts = 0, next_attempt_at = NULL,
                updated_at = now()
         WHERE id = $1`,
        [id]
      )
    } else if (step === 'speakers') {
      await exec(`UPDATE transcript_cue SET speaker = '' WHERE recording_id = $1`, [id])
      await exec('DELETE FROM summary_part WHERE recording_id = $1', [id])
      await exec(
        `UPDATE recording SET speaker_state = 'pending', speaker_error = '', speaker_attempts = 0,
                speakers = '{}'::jsonb, summary_state = 'pending', summary_attempts = 0,
                next_attempt_at = NULL, updated_at = now()
         WHERE id = $1`,
        [id]
      )
    } else {
      await exec(
        `DELETE FROM summary_part WHERE recording_id = $1 AND state <> 'done'`,
        [id]
      )
      /*
       * `recap_todos_at` is cleared and `recap_written_at` is not, and that asymmetry
       * is the point of having two of them. Asking for the recap again means you want
       * the new answer — so whatever it now finds somebody has to do is added to the
       * to-do list, deduplicated against what is already there. The write-up is left
       * alone, because appending a second recap to a document you have been editing
       * is not what anybody means by "try again".
       */
      await exec(
        `UPDATE recording SET summary_state = 'pending', summary_error = '', summary_attempts = 0,
                recap_todos_at = NULL, next_attempt_at = NULL, updated_at = now()
         WHERE id = $1`,
        [id]
      )
    }
    kick()
    return view(id)
  })

  handle('recording:deleteAudio', async ({ id }) => {
    await requireIdle(id)
    // Deleting the audio is a trade: the sound for the words. Refused while there
    // are no words yet — including after a failed transcription, where the audio is
    // the only thing a retry could work from.
    const words = await q1<{ n: number }>(
      'SELECT count(*)::int AS n FROM transcript_cue WHERE recording_id = $1',
      [id]
    )
    if (Number(words?.n ?? 0) === 0) {
      throw new Error(
        'This recording has not been transcribed yet. Deleting the audio now would lose the words with it.'
      )
    }
    await deleteAudio(id)
    // The audio has gone; the rows stay so the transcript still knows what it came
    // from. Through updateWhere so the other Mac learns the bytes are not coming.
    await updateWhere('recording_segment', { recordingId: id }, { path: '', bytes: 0 })
    await upsert('recording', { audioDeletedAt: new Date(), bytes: 0, updatedAt: new Date() }, id)
    await announce(id)
    return view(id)
  })

  handle('recording:delete', async ({ id }) => {
    await requireIdle(id)
    const { projectId } = await meetingOf(id)
    await deleteAudio(id)
    await remove('recording', id)
    await mirrorProject(projectId)
  })

  handle('recording:nameSpeaker', async ({ id, label, name, personId }) => {
    const row = await q1<any>('SELECT speakers FROM recording WHERE id = $1', [id])
    if (!row) throw new Error('That recording is no longer here.')
    const speakers: Record<string, SpeakerName> =
      typeof row.speakers === 'string' ? JSON.parse(row.speakers) : (row.speakers ?? {})
    // A name is put on the label, never on the lines: the transcript keeps saying
    // "Speaker 2" underneath, so renaming is one write and is always reversible.
    speakers[label] = { name: name.trim().slice(0, 80), personId: personId ?? null }
    await upsert('recording', { speakers: JSON.stringify(speakers), updatedAt: new Date() }, id)
    return view(id)
  })

  /*
   * Turning the recap into part of the meeting.
   *
   * Everything here goes through the channels the interface uses — `meeting:save`
   * and `meetingTodo:save` — rather than through SQL of its own, so a to-do the
   * recap produced is the same row, in the same place, with the same behaviour as
   * one you typed: it can be ticked, promoted to the board, or deleted, and it
   * rewrites the Markdown mirror on its way in.
   *
   * It happens once. `recap_written_at` is the marker, and a second call is a no-op
   * — because the write-up is a document you edit, and a process that rewrote it
   * every time the recap changed would eventually overwrite a sentence you wrote.
   */
  handle('recording:applyRecap', async ({ id }) => {
    const row = await q1<any>('SELECT * FROM recording WHERE id = $1', [id])
    if (!row) throw new Error('That recording is no longer here.')

    const meeting = await q1<any>('SELECT id, title, body FROM meeting WHERE id = $1', [
      row.meeting_id
    ])
    if (!meeting) throw new Error('That meeting is no longer here.')
    if (row.recap_written_at && row.recap_todos_at) return meetingView(meeting.id)

    const recap: Recap = {
      ...EMPTY_RECAP,
      ...(typeof row.recap === 'string' ? JSON.parse(row.recap) : (row.recap ?? {}))
    }

    /*
     * The write-up and the to-do items are marked off separately, and that is not
     * fussiness: they can fail apart. If creating the to-dos goes wrong halfway, the
     * step is retried — and a retry that re-ran the part above would append the recap
     * to the write-up a second time. One marker each, and each one set the moment its
     * own work is done.
     */
    if (!row.recap_written_at) {
      const markdown = recapMarkdown(row.summary ?? '', recap)
      if (!markdown) throw new Error('There is no recap to fold in yet.')

      // Appended rather than inserted at the top, and separated by a blank line, so
      // notes typed during the meeting stay where they were written and the recap
      // reads as what it is: what the recording made of all that afterwards.
      const body = meeting.body?.trim()
        ? `${meeting.body.trimEnd()}\n\n${markdown}\n`
        : `${markdown}\n`

      await invokeChannel('meeting:save', {
        id: meeting.id,
        body,
        // A name you typed is never overwritten. This only ever names a meeting that
        // was never named, which is most of them when the recording is the point.
        ...(meeting.title?.trim() ? {} : { title: row.suggested_title || '' })
      })
      await upsert('recording', { recapWrittenAt: new Date(), updatedAt: new Date() }, id)
    }

    // Somebody saying they will do something is the one part of a recap that is
    // really work, so it lands where the meeting's work lands — the to-do list in the
    // rail — rather than staying in a panel you have to remember to read.
    if (!row.recap_todos_at) {
      const current = await meetingView(meeting.id)
      const existing = new Set(current.todos.map((t) => t.text.trim().toLowerCase()))
      for (const commitment of recap.commitments) {
        const text = commitmentLine(commitment).trim()
        if (!text || existing.has(text.toLowerCase())) continue
        existing.add(text.toLowerCase())
        await invokeChannel('meetingTodo:save', { meetingId: meeting.id, text })
      }
      await upsert('recording', { recapTodosAt: new Date(), updatedAt: new Date() }, id)
    }

    await announce(id)
    return meetingView(meeting.id)
  })

  handle('systemAudio:available', () => ({ available: systemAudioAvailable() }))
  handle('systemAudio:start', () => startSystemAudio())
  handle('systemAudio:stop', () => stopSystemAudio())
  handle('systemAudio:test', () => testSystemAudio())

  handle('recording:requestMic', async () => {
    if (process.platform !== 'darwin') return { granted: true }
    try {
      // macOS only shows its own prompt in answer to this, from the application. A
      // getUserMedia inside the window is refused silently without it.
      const granted = await systemPreferences.askForMediaAccess('microphone')
      return { granted }
    } catch {
      return { granted: false }
    }
  })
}
