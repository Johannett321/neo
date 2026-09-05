import OpenAI from 'openai'
import type { Engine } from '@shared/recording'
import {
  LOCAL_RECAP_BASE_URL, LOCAL_RECAP_MODEL, LOCAL_TRANSCRIBE_BASE_URL, LOCAL_TRANSCRIBE_MODEL,
  OPENAI_TRANSCRIBE_MODEL
} from '@shared/recording'
import { DEFAULT_MODEL } from '@shared/ai'
import { q1 } from '../../db/client'

/**
 * Who does the work, and where.
 *
 * Both engines are reached through the same client, because "local" here means an
 * OpenAI-compatible server rather than a second protocol: Ollama serves one at
 * /v1, and so do whisper.cpp's server, faster-whisper-server, Speaches and LocalAI.
 * That is the entire difference between the two settings — a base URL and whether a
 * key is required — which is why there is one code path below and not two.
 *
 * The distinction that is *not* cosmetic is which one a workspace is set to. A
 * client's conversations may be under a contract that forbids them leaving the
 * machine while the day job's are not, so the choice lives on the workspace beside
 * the API key, and a recording is transcribed by whichever engine its workspace
 * named — never by whichever one happens to be reachable.
 */

export interface EngineConfig {
  client: OpenAI
  engine: Engine
  model: string
  /** ISO 639-1 or empty. Only transcription takes one. */
  language: string
}

interface WorkspaceRow {
  id: string
  name: string
  ai_api_key: string
  ai_model: string
  transcribe_engine: string
  transcribe_model: string
  transcribe_base_url: string
  transcribe_language: string
  recap_engine: string
  recap_model: string
  recap_base_url: string
  recap_prompt: string
}

export async function workspaceOfMeeting(meetingId: string): Promise<WorkspaceRow> {
  const row = await q1<WorkspaceRow>(
    `SELECT w.* FROM meeting m
     JOIN project p   ON p.id = m.project_id
     JOIN workspace w ON w.id = p.workspace_id
     WHERE m.id = $1`,
    [meetingId]
  )
  if (!row) throw new Error('That meeting is no longer in a workspace.')
  return row
}

export async function workspaceOfRecording(recordingId: string): Promise<WorkspaceRow> {
  const row = await q1<WorkspaceRow>(
    `SELECT w.* FROM recording r
     JOIN meeting m  ON m.id = r.meeting_id
     JOIN project p  ON p.id = m.project_id
     JOIN workspace w ON w.id = p.workspace_id
     WHERE r.id = $1`,
    [recordingId]
  )
  if (!row) throw new Error('That recording is no longer attached to a workspace.')
  return row
}

/**
 * A missing key is a settings problem, not a transient one, so it is worth saying in
 * the words the settings screen uses rather than letting a 401 come back from the API.
 */
function requireKey(row: WorkspaceRow, what: string): string {
  if (!row.ai_api_key) {
    throw new Error(
      `${row.name} has no OpenAI API key, so ${what} cannot run. Add one in workspace ` +
        'settings under Assistant, or switch this workspace to a local engine under Recording.'
    )
  }
  return row.ai_api_key
}

export function transcribeEngine(row: WorkspaceRow): EngineConfig {
  const engine: Engine = row.transcribe_engine === 'local' ? 'local' : 'openai'
  const language = (row.transcribe_language ?? '').trim()

  if (engine === 'local') {
    return {
      // A local server almost never checks the key, and the ones that do take
      // anything; sending a real one to a random port would be the actual mistake.
      client: new OpenAI({
        apiKey: 'local',
        baseURL: (row.transcribe_base_url || LOCAL_TRANSCRIBE_BASE_URL).replace(/\/+$/, '')
      }),
      engine,
      model: row.transcribe_model || LOCAL_TRANSCRIBE_MODEL,
      language
    }
  }
  return {
    client: new OpenAI({ apiKey: requireKey(row, 'transcription') }),
    engine,
    model: row.transcribe_model || OPENAI_TRANSCRIBE_MODEL,
    language
  }
}

export function recapEngine(row: WorkspaceRow): EngineConfig {
  const engine: Engine = row.recap_engine === 'local' ? 'local' : 'openai'

  if (engine === 'local') {
    return {
      client: new OpenAI({
        apiKey: 'local',
        baseURL: (row.recap_base_url || LOCAL_RECAP_BASE_URL).replace(/\/+$/, '')
      }),
      engine,
      model: row.recap_model || LOCAL_RECAP_MODEL,
      language: ''
    }
  }
  return {
    client: new OpenAI({ apiKey: requireKey(row, 'the recap') }),
    engine,
    model: row.recap_model || DEFAULT_MODEL,
    language: ''
  }
}

/**
 * Errors a later attempt might survive, told apart from the ones it will not.
 *
 * A key that is wrong, a model that does not exist and audio the server refuses are
 * all going to fail again in five minutes, so the pipeline stops and says so rather
 * than working through five attempts to reach the same sentence. A timeout, a
 * connection refused because Ollama is not running yet, or a rate limit are all
 * worth another go — the laptop that just woke up is the normal case here.
 */
export function isPermanent(error: unknown): boolean {
  if (error instanceof OpenAI.AuthenticationError) return true
  if (error instanceof OpenAI.PermissionDeniedError) return true
  if (error instanceof OpenAI.NotFoundError) return true
  if (error instanceof OpenAI.BadRequestError) return true
  return false
}

export function describeEngineError(error: unknown, config: EngineConfig): string {
  if (error instanceof OpenAI.AuthenticationError) {
    return 'That API key was rejected. Check it in workspace settings, under Assistant.'
  }
  if (error instanceof OpenAI.NotFoundError) {
    return `The model "${config.model}" is not available on this endpoint. Change it in workspace settings, under Recording.`
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return config.engine === 'local'
      ? `Could not reach the local server at ${config.client.baseURL}. Start it and this will pick up on its own.`
      : 'Could not reach OpenAI. This will be tried again on its own.'
  }
  if (error instanceof OpenAI.RateLimitError) return 'Rate limited; waiting before the next attempt.'
  if (error instanceof OpenAI.APIError) return `${error.status}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
