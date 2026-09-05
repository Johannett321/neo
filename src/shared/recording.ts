/**
 * Recording a meeting, from the microphone to the recap.
 *
 * The constants live here rather than in the main process because both sides need
 * them: the renderer holds the microphone and has to know how long a segment runs
 * for, and main holds the pipeline and has to know what a segment is when one
 * arrives. `api.ts` is the contract for the messages; this is the contract for the
 * shape of the thing they carry.
 */

/**
 * Where a capture is. `interrupted` is the one that matters: it means the app was
 * recording and then stopped being — a crash, a quit, a machine that lost power —
 * and the audio captured up to that point is on disk and safe. It is deliberately
 * not `stopped`, because a meeting that is still happening should be resumed rather
 * than transcribed, and only the person in the room knows which.
 */
export type CaptureState = 'recording' | 'interrupted' | 'stopped'

/** Every step of the pipeline reports itself the same way. */
export type Stage = 'pending' | 'running' | 'done' | 'failed'

/** Which service does the work. `local` is any OpenAI-compatible server you run. */
export type Engine = 'openai' | 'local'

/**
 * How long one file of audio runs for before the next one starts.
 *
 * Five minutes is a compromise between three things, and it is the single most
 * load-bearing number in this feature. A power cut can only ever lose what has not
 * been flushed — a second — but a *file* that is still open when the machine dies is
 * the thing most likely to be unreadable, so short files bound the damage. Every
 * segment is also transcribed on its own, so a two-hour meeting resumes at the
 * five-minute mark it got to rather than starting again. And it keeps every upload
 * comfortably under the 25 MB that transcription APIs accept.
 */
export const SEGMENT_MS = 5 * 60 * 1000

/**
 * How often the browser hands us bytes to write. Everything already handed over is
 * on disk, so this is the true size of the window in which audio can be lost.
 */
export const CHUNK_MS = 1000

/** How often the renderer says it is still recording, and how stale is dead. */
export const HEARTBEAT_MS = 4000
export const HEARTBEAT_DEAD_MS = 20_000

/**
 * Opus at 48 kbit/s mono. Speech is intelligible far below this and transcription
 * models want no more; an hour of meeting costs about 20 MB, which is a size you can
 * keep without thinking about it.
 */
export const AUDIO_BITS_PER_SECOND = 48_000

/** In preference order. The first one the browser admits to is used. */
export const AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
]

/** Give up and ask for a human after this many goes at the same step. */
export const MAX_ATTEMPTS = 5

/** Backoff between attempts, in milliseconds, indexed by attempt number. */
export const backoffMs = (attempts: number): number =>
  Math.min(15 * 60_000, 20_000 * 2 ** Math.max(0, attempts - 1))

/* ------------------------------------------------------------------- engines */

/**
 * Ollama does not transcribe — it runs language models and nothing else. Local
 * transcription therefore means an OpenAI-compatible speech server you run yourself
 * (whisper.cpp's `whisper-server`, faster-whisper-server, Speaches, LocalAI), and
 * the setting is a base URL rather than a checkbox so that any of them will do.
 */
export const LOCAL_TRANSCRIBE_BASE_URL = 'http://127.0.0.1:8080/v1'
export const LOCAL_TRANSCRIBE_MODEL = 'whisper-1'

/** Ollama's own OpenAI-compatible endpoint, which is where the recap goes locally. */
export const LOCAL_RECAP_BASE_URL = 'http://127.0.0.1:11434/v1'
export const LOCAL_RECAP_MODEL = 'llama3.2'

/**
 * `whisper-1` rather than one of the newer transcription models, and deliberately:
 * it is the only one that returns per-phrase timestamps, and without those the
 * transcript cannot follow the playhead, which is half of what this screen is for.
 */
export const OPENAI_TRANSCRIBE_MODEL = 'whisper-1'

export interface TranscribeModelChoice {
  id: string
  label: string
  hint: string
}

export const OPENAI_TRANSCRIBE_MODELS: TranscribeModelChoice[] = [
  {
    id: 'whisper-1',
    label: 'Whisper',
    hint: 'The default. Returns the timestamps the transcript needs to follow playback.'
  },
  {
    id: 'gpt-4o-transcribe',
    label: 'GPT-4o transcribe',
    hint: 'More accurate on hard audio, but no timestamps — the transcript will not follow along.'
  },
  {
    id: 'gpt-4o-mini-transcribe',
    label: 'GPT-4o mini transcribe',
    hint: 'Cheaper than the above, and also without timestamps.'
  }
]

/** True for models that cannot return per-phrase times, so callers stop asking. */
export const hasTimestamps = (model: string): boolean => !/^gpt-/.test(model)

/* -------------------------------------------------------------------- prompt */

/**
 * What the recap is asked for, before the part that cannot be edited.
 *
 * This is the half of the prompt that is yours: it says what to look for and what to
 * leave out. The output *shape* is appended by the main process and is not editable,
 * because the screen reads it as data — a prompt that could change the shape would
 * be a prompt that could break the screen.
 */
export const DEFAULT_RECAP_PROMPT = `You are writing up a meeting for someone who was in the room and will read this in three months, when they remember none of it.

What matters:
- **Decisions.** Something that was settled. Say what was decided, and by whom if the transcript makes that clear. A decision that was deferred is not a decision — say it was deferred, under insights.
- **Commitments.** Anything the meeting says has to be done afterwards. All of these count: someone promising to do something ("I'll write that up"), a task handed to someone ("Ida, can you chase the invoice"), and a to-do simply read out or listed as something to be done. If the meeting is somebody going through a list of tasks, then that list *is* the commitments — every item on it, one each. Name the person it belongs to when the transcript makes that clear, and leave the name out rather than guessing at one. Give a date only if one was said out loud, and never invent one.
- **Key insights.** The things that change how you see the work: a constraint that surfaced, a risk somebody named, a number that landed, a disagreement that was left open. Never put an action here. If it is something someone has to go and do, it is a commitment, however casually it was said.

What to leave out:
- Small talk, greetings, goodbyes, scheduling chatter, "can you hear me", weather, holidays, and anything about the meeting itself rather than its subject.
- Restating the agenda. Nobody needs to be told what the meeting was about; they need to know what came out of it.
- Padding. If nothing was decided, say so and leave the list empty rather than promoting a vague remark to a decision.

Be specific and quote a phrase where the exact words matter. Never invent anything that is not in the transcript.`

/* ------------------------------------------------------------------ speakers */

/** How an unidentified voice is labelled before anyone puts a name to it. */
export const speakerLabel = (index: number): string => `Speaker ${index + 1}`


/* --------------------------------------------------------------- system audio */

/** What `systemAudio:start` answers with. Never an exception — see the channel. */
export interface SystemAudioStart {
  ok: boolean
  /** The rate the tap runs at; the renderer builds its audio graph around it. */
  sampleRate: number
  /** Why not, in words a person can act on. Empty when it started. */
  reason: string
}

/**
 * How much of the computer's audio the renderer will hold before dropping the oldest.
 *
 * The tap and the microphone are separate clocks, and the buffer between them is
 * where that difference shows up. Half a second is far more than the jitter of a
 * healthy machine and far less than anybody can hear as being behind; past it,
 * something has stalled and the newest audio is worth more than the oldest.
 */
export const SYSTEM_AUDIO_BUFFER_MS = 500
