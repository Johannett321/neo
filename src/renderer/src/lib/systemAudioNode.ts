import { SYSTEM_AUDIO_BUFFER_MS } from '@shared/recording'

/**
 * The computer's own audio, arriving over IPC, turned into something the Web Audio
 * graph can mix.
 *
 * The native helper reads a Core Audio process tap and writes raw 16-bit mono PCM;
 * main forwards it here. There is no `MediaStream` to be had — the audio never went
 * near a capture device the browser knows about — so it is put into the graph by
 * hand and joined to the microphone there.
 *
 * It is scheduled as a run of short buffers rather than fed through an
 * `AudioWorkletNode`, and that is not a stylistic choice. A worklet has to be loaded
 * as a *script*, and this application's Content-Security-Policy is `script-src
 * 'self'` — so a worklet built from a blob is blocked, silently, in development and
 * in the packaged app alike. Weakening the policy to allow `blob:` would trade a real
 * security property of the whole renderer for one audio node. Buffers need no script,
 * so the policy stays exactly as strict as it was.
 *
 * The two sides have separate clocks — the microphone runs on its own device and the
 * tap on the output device — so the schedule is allowed to slip. Falling behind
 * restarts it just ahead of now; running too far ahead drops a chunk. Latency stays
 * bounded either way and drift never accumulates.
 */

/** How far ahead of the clock a chunk is scheduled. Enough to absorb IPC jitter. */
const LEAD_S = 0.06

/** Past this, the tap is outrunning the graph and the oldest audio is worth least. */
const MAX_LEAD_S = SYSTEM_AUDIO_BUFFER_MS / 1000

export interface SystemAudioFeed {
  /** Connect this to the mixing bus. */
  node: AudioNode
  /** Stops listening to main and takes the node out of the graph. */
  release: () => void
}

export function createSystemAudioFeed(
  context: AudioContext,
  /** The tap's own rate. The buffers say so, so a mismatch resamples instead of detuning. */
  sampleRate: number
): SystemAudioFeed {
  const gain = context.createGain()
  let cursor = 0

  const stop = window.api.onSystemAudio((chunk) => {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const count = bytes.byteLength >> 1
    if (count === 0) return

    const now = context.currentTime
    // Behind the clock: everything scheduled has already played, so start again just
    // ahead of now rather than in the past, where it would simply be dropped.
    if (cursor < now + LEAD_S) cursor = now + LEAD_S
    // Ahead of it: the tap is producing faster than this graph consumes, which over
    // an hour is the difference between two crystals. Let a chunk go instead.
    if (cursor - now > MAX_LEAD_S) return

    const buffer = context.createBuffer(1, count, sampleRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < count; i++) {
      // Little-endian pairs, sign-extended. Read out rather than cast over, because
      // the bytes are not guaranteed to land on a boundary an Int16Array will view.
      channel[i] = (((bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16) >> 16) / 32768
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.start(cursor)
    cursor += buffer.duration
  })

  return {
    node: gain,
    release: () => {
      stop()
      gain.disconnect()
    }
  }
}
