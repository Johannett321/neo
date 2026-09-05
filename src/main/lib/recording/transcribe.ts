import { toFile } from 'openai'
import { hasTimestamps } from '@shared/recording'
import type { EngineConfig } from './engine'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One segment of audio turned into timed phrases.
 *
 * The times are what make the rest of the screen work — the transcript follows the
 * playhead, and clicking a line seeks to it — so `whisper-1` is the default even
 * though newer models transcribe better: it is the one that still returns them.
 * When a model that does not is chosen anyway, the whole segment comes back as one
 * cue spanning its own length, which reads correctly and simply cannot follow along.
 */

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

/** A phrase shorter than this is almost always a stray token; fold it into its neighbour. */
const MIN_CUE_MS = 200

export async function transcribeSegment(
  config: EngineConfig,
  audio: Buffer,
  filename: string,
  durationMs: number
): Promise<Cue[]> {
  const timestamps = hasTimestamps(config.model)
  const file = await toFile(audio, filename)

  const response = (await config.client.audio.transcriptions.create({
    file,
    model: config.model,
    response_format: timestamps ? 'verbose_json' : 'json',
    ...(config.language ? { language: config.language } : {}),
    // Whisper drops repeated phrases and hallucinates over silence far less when it
    // is told what kind of audio this is.
    prompt: 'A recording of a work meeting between several people.'
  } as any)) as any

  if (!timestamps || !Array.isArray(response?.segments)) {
    const text = String(response?.text ?? '').trim()
    return text ? [{ startMs: 0, endMs: durationMs, text }] : []
  }

  const cues: Cue[] = []
  for (const raw of response.segments as any[]) {
    const text = String(raw?.text ?? '').trim()
    if (!text) continue
    const startMs = Math.max(0, Math.round(Number(raw?.start ?? 0) * 1000))
    const endMs = Math.max(startMs + MIN_CUE_MS, Math.round(Number(raw?.end ?? 0) * 1000))
    const previous = cues[cues.length - 1]
    // Whisper occasionally emits the same phrase twice at a boundary. One of them.
    if (previous && previous.text === text && startMs - previous.endMs < MIN_CUE_MS) continue
    cues.push({ startMs, endMs, text })
  }
  return cues
}
