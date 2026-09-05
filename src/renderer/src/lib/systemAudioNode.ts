import { SYSTEM_AUDIO_BUFFER_MS } from '@shared/recording'

/**
 * The computer's own audio, arriving over IPC, turned into something the Web Audio
 * graph can mix.
 *
 * The native helper reads a Core Audio process tap and writes raw 16-bit mono PCM;
 * main forwards it here. There is no `MediaStream` to be had — the audio never went
 * near a capture device the browser knows about — so it is fed into an
 * `AudioWorkletNode` by hand and joined to the microphone inside the graph.
 *
 * The two have separate clocks, and that is what the ring buffer is for. The mic is
 * driven by its own device and the tap by the output device; over an hour they will
 * not agree to the sample. The worklet reads at exactly the graph's rate, outputs
 * silence when it has nothing (which is most of a meeting — a tap produces nothing
 * while nothing is playing) and drops the oldest audio when it is more than half a
 * second behind. Latency therefore stays bounded and drift never accumulates.
 */

/**
 * The processor, as source, because an `AudioWorklet` module must be fetched from a
 * URL. A blob is that URL — the alternative is a separate build entry point for
 * twenty lines of code that has to stay in step with this file.
 */
const PROCESSOR = `
class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const capacity = options.processorOptions.capacity
    this.ring = new Float32Array(capacity)
    this.capacity = capacity
    this.read = 0
    this.write = 0
    this.filled = 0

    this.port.onmessage = (event) => {
      const samples = event.data
      if (!samples) return
      // More than the buffer holds means something upstream stalled. The newest audio
      // is the audio somebody is speaking now; the oldest is already too late.
      const room = this.capacity - this.filled
      if (samples.length > room) {
        const drop = samples.length - room
        this.read = (this.read + drop) % this.capacity
        this.filled -= drop
      }
      for (let i = 0; i < samples.length; i++) {
        this.ring[this.write] = samples[i] / 32768
        this.write = (this.write + 1) % this.capacity
      }
      this.filled += samples.length
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    for (let i = 0; i < out.length; i++) {
      if (this.filled > 0) {
        out[i] = this.ring[this.read]
        this.read = (this.read + 1) % this.capacity
        this.filled--
      } else {
        // Nothing playing on the machine. Silence is the correct answer, and it is
        // also what keeps the microphone's timeline the one that matters.
        out[i] = 0
      }
    }
    return true
  }
}

registerProcessor('system-audio', SystemAudioProcessor)
`

let moduleUrl = ''

export interface SystemAudioFeed {
  node: AudioWorkletNode
  /** Stops listening to main. The node itself is disconnected by closing the context. */
  release: () => void
}

/**
 * Adds the worklet to a context and starts feeding it. Returns null when the worklet
 * cannot be created at all, so the caller falls back to the microphone alone rather
 * than losing the recording over the half of it that is a bonus.
 */
export async function createSystemAudioFeed(
  context: AudioContext
): Promise<SystemAudioFeed | null> {
  try {
    if (!moduleUrl) {
      moduleUrl = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }))
    }
    await context.audioWorklet.addModule(moduleUrl)

    const node = new AudioWorkletNode(context, 'system-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        capacity: Math.ceil((context.sampleRate * SYSTEM_AUDIO_BUFFER_MS) / 1000)
      }
    })

    const stop = window.api.onSystemAudio((chunk) => {
      // The bytes arrive as a copy already, but not necessarily aligned to a sample
      // boundary that `Int16Array` will accept a view of, so the pairs are read out
      // rather than cast over.
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const count = bytes.byteLength >> 1
      if (count === 0) return
      const samples = new Int16Array(count)
      for (let i = 0; i < count; i++) {
        samples[i] = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16
      }
      node.port.postMessage(samples, [samples.buffer])
    })

    return { node, release: stop }
  } catch {
    return null
  }
}
