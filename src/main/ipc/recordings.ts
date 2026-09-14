import { systemPreferences } from 'electron'
import { api, CloudError, must, upload } from '../lib/cloud/client'
import {
  startSystemAudio, stopSystemAudio, systemAudioAvailable, testSystemAudio
} from '../lib/recording/systemAudio'
import { handle } from './util'

/**
 * Recording a meeting, from this side of the bridge.
 *
 * Only a renderer can open a microphone, so the renderer holds it — and nothing else.
 * Every second of audio is handed over here and sent to Neo Cloud, which keeps it as a
 * row the moment it arrives and joins a segment's seconds into one file when the
 * segment closes. Transcription, speakers and the recap run on the server, whether or
 * not this machine is still open.
 *
 * Nothing is written to this machine's disk, so what stands between a dropped
 * connection and lost audio is the queue below: a chunk that cannot be sent is kept in
 * memory, in order, and sent when the connection comes back. The renderer awaits each
 * one, so a recording that has lost the network says so rather than carrying on as if
 * nothing were wrong.
 */

interface Pending {
  segmentId: string
  seq: number
  bytes: Uint8Array
  settle: { resolve: (value: { bytes: number }) => void; reject: (error: Error) => void }
}

/** The position of the next chunk in each open segment. A retry resends the same one. */
const nextSeq = new Map<string, number>()
const queue: Pending[] = []
let draining = false

/** How long a chunk waits for the network before the renderer is told the audio is held. */
const PATIENCE_MS = 15_000
const RETRY_MS = 1_000
const RETRY_CEILING_MS = 10_000

function enqueueChunk(segmentId: string, bytes: Uint8Array): Promise<{ bytes: number }> {
  const seq = nextSeq.get(segmentId) ?? 0
  nextSeq.set(segmentId, seq + 1)
  return new Promise((resolve, reject) => {
    queue.push({ segmentId, seq, bytes, settle: { resolve, reject } })
    void drain()
  })
}

/**
 * Send what is waiting, oldest first, and keep trying.
 *
 * A refusal the server means (the segment is closed, the recording is gone) settles
 * the chunk and moves on: sending it again would be refused again. Anything that looks
 * like the network is retried with backoff for as long as the app is open. The
 * renderer is answered with an error once a chunk has waited PATIENCE_MS, so it can say
 * the audio is being held — but the chunk stays in the queue and is still sent.
 */
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const head = queue[0]
      const started = Date.now()
      let backoff = RETRY_MS
      let told = false
      for (;;) {
        try {
          const result = await upload<{ bytes: number }>(
            `/v1/recording-segments/${head.segmentId}/chunks`, { seq: head.seq }, head.bytes)
          if (!told) head.settle.resolve(result)
          break
        } catch (error) {
          const status = error instanceof CloudError ? error.status : 0
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            if (!told) head.settle.reject(error as Error)
            break
          }
          if (!told && Date.now() - started > PATIENCE_MS) {
            told = true
            head.settle.reject(new Error(
              'Neo Cloud cannot be reached. The audio is being held and will be sent when the connection returns.'))
          }
          await new Promise((resolve) => setTimeout(resolve, backoff))
          backoff = Math.min(backoff * 2, RETRY_CEILING_MS)
        }
      }
      queue.shift()
    }
  } finally {
    draining = false
  }
}

/** Wait for every chunk of a segment to have gone before saying it is finished. */
async function flushed(segmentId: string): Promise<void> {
  while (queue.some((chunk) => chunk.segmentId === segmentId)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export function registerRecordingHandlers(): void {
  handle('recording:start', ({ meetingId }) => must(api.POST('/v1/recordings', { body: { meetingId } })))

  handle('recording:resume', ({ id }) =>
    must(api.POST('/v1/recordings/{id}/resume', { params: { path: { id } } })))

  handle('recording:openSegment', async ({ id }) => {
    const opened = await must(api.POST('/v1/recordings/{id}/segments', { params: { path: { id } } }))
    nextSeq.set(opened.segmentId, 0)
    return opened
  })

  handle('recording:appendChunk', ({ segmentId, data }) =>
    enqueueChunk(segmentId, new Uint8Array(Buffer.from(data, 'base64'))))

  handle('recording:closeSegment', async ({ segmentId, durationMs }) => {
    await flushed(segmentId)
    nextSeq.delete(segmentId)
    await must(api.POST('/v1/recording-segments/{id}/close', {
      params: { path: { id: segmentId } },
      body: { durationMs: Math.max(0, Math.round(durationMs)) }
    }))
  })

  handle('recording:heartbeat', async ({ id, durationMs }) => {
    await must(api.POST('/v1/recordings/{id}/heartbeat', {
      params: { path: { id } },
      body: { durationMs: Math.max(0, Math.round(durationMs)) }
    }))
  })

  handle('recording:stop', async ({ id, durationMs }) => {
    // Every second already captured goes before the capture is called finished.
    while (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 100))
    return must(api.POST('/v1/recordings/{id}/stop', {
      params: { path: { id } },
      body: { durationMs: Math.max(0, Math.round(durationMs)) }
    }))
  })

  handle('recording:get', ({ meetingId }) =>
    must(api.GET('/v1/meetings/{id}/recording', { params: { path: { id: meetingId } } })))

  handle('recording:retry', ({ id, step }) =>
    must(api.POST('/v1/recordings/{id}/retry', { params: { path: { id } }, body: { step } })))

  handle('recording:deleteAudio', ({ id }) =>
    must(api.DELETE('/v1/recordings/{id}/audio', { params: { path: { id } } })))

  handle('recording:delete', async ({ id }) => {
    await must(api.DELETE('/v1/recordings/{id}', { params: { path: { id } } }))
  })

  handle('recording:nameSpeaker', ({ id, label, name, personId }) =>
    must(api.PUT('/v1/recordings/{id}/speakers', {
      params: { path: { id } },
      body: { label, name, personId: personId ?? null }
    })))

  handle('recording:applyRecap', ({ id }) =>
    must(api.POST('/v1/recordings/{id}/recap/apply', { params: { path: { id } } })))

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
