import type { AiEvent, AttachmentUpload, ChatSendResult } from '@shared/types'
import { MAX_ATTACHMENT_BYTES, shapeOf } from '../attachments'
import { announceChange } from '../changes'
import { api, CloudError, fetchRaw, must, readJson, upload } from './client'

/**
 * The assistant, as this app reaches it: a message out, a stream of events back.
 *
 * The turn runs in Neo Cloud — the model call, the tools, the confirmations and the
 * saving of every step. Nothing about it is decided here. This module opens
 * `POST /v1/assistant/runs` with the device's token (which never leaves the main
 * process), reads the server-sent events it answers with, and hands each one on as the
 * `AiEvent` the panel already understood when the loop lived in this process. The
 * server's event data is that shape on purpose, so relaying is a parse and nothing else.
 */

export interface RunInput {
  workspaceId: string
  conversationId?: string
  text: string
  files?: AttachmentUpload[]
  projectId?: string
}

/**
 * Each event's data, one at a time, from a `text/event-stream` body.
 *
 * Only `data:` lines matter — the event's name travels inside the data as `type` — and a
 * data line may be split across any number of network chunks, so the text is buffered
 * until the blank line that ends an event. Comments (`:` lines, a server's keep-alive)
 * and anything that is not JSON are skipped rather than ending the stream.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  const parse = function* (block: string): Generator<Record<string, unknown>> {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) return
    try {
      const value = JSON.parse(data) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>
    } catch {
      // Not ours to understand; the next event may well be.
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        yield* parse(block)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* parse(buffer.replace(/\r\n?/g, '\n'))
  } finally {
    reader.releaseLock()
  }
}

/**
 * What a refusal to start says. A 429 is today's allowance spent, which the panel shows
 * as the "Neo Pro — coming soon" card rather than an error, so it comes back as a value;
 * anything else is an error, in the server's own sentence.
 */
export async function refusalOf(response: Response): Promise<ChatSendResult> {
  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as { error?: string; limit?: string } | null
    return {
      started: false,
      limit: body?.limit === 'transcription' ? 'transcription' : 'assistant',
      message: body?.error || 'Today’s allowance is used up. Neo Pro is coming soon.'
    }
  }
  // readJson throws the server's sentence for anything that is not a success.
  await readJson(response)
  throw new CloudError(response.status, `Neo Cloud answered ${response.status}.`)
}

/**
 * Files go in before the message that carries them, so a refused or failed send does not
 * lose what was dropped in. They belong to a conversation, so a first message with files
 * opens its conversation here rather than leaving that to the run.
 */
async function uploadFiles(input: RunInput): Promise<{ conversationId?: string; attachmentIds: string[] }> {
  const files = input.files ?? []
  if (!files.length) return { conversationId: input.conversationId, attachmentIds: [] }
  for (const file of files) {
    if (!shapeOf(file.name, file.mime)) throw new Error(`${file.name} is not a kind of file the assistant can read.`)
    if (Buffer.byteLength(file.data, 'base64') > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 20 MB.`)
  }
  const conversationId = input.conversationId
    ?? (await must(api.POST('/v1/conversations', { body: { workspaceId: input.workspaceId } }))).id
  const attachmentIds: string[] = []
  for (const file of files) {
    const row = await upload<{ id: string }>(`/v1/conversations/${conversationId}/attachments`,
      { filename: file.name, mime: file.mime }, new Uint8Array(Buffer.from(file.data, 'base64')))
    attachmentIds.push(row.id)
  }
  return { conversationId, attachmentIds }
}

/**
 * Start a turn. Resolves once Neo Cloud has said `started` — the message is saved and
 * the conversation exists — and keeps relaying the rest of the stream to `emit` after
 * that, detached, because a turn with a question in it can wait for minutes and an IPC
 * call that blocks that long is one that has hung.
 *
 * The turn does not depend on this stream: if the connection drops, Neo Cloud finishes
 * it anyway and saves it. The panel is told the connection went, and then `done`, so it
 * refetches the conversation and shows what the server has.
 */
export async function startRun(input: RunInput, emit: (event: AiEvent) => void): Promise<ChatSendResult> {
  const { conversationId, attachmentIds } = await uploadFiles(input)
  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    text: input.text,
    ...(conversationId ? { conversationId } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {})
  })
  const response = await fetchRaw('/v1/assistant/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: new TextEncoder().encode(body)
  })
  if (!response.ok || !response.body) return refusalOf(response)

  const events = readEvents(response.body)
  const first = await events.next().catch(() => null)
  const started = first && !first.done ? (first.value as AiEvent) : null
  if (!started || started.type !== 'started') {
    const message = started?.type === 'error' ? started.message : 'Neo Cloud did not start the assistant. Try again.'
    throw new Error(message)
  }
  emit(started)

  void (async () => {
    let finished = false
    /*
     * The tools write in Neo Cloud as this device, and Neo Cloud tells every *other*
     * device about a write, never the one that made it — so the event stream is silent
     * here. A write is always asked about first, so a tool that finishes after an
     * `approval` is a write that landed, and the window is told at that moment: the
     * card appears while the assistant is still talking. A read says nothing, so the
     * assistant looking things up never makes the screen refetch.
     */
    const writes = new Set<string>()
    try {
      for await (const event of events) {
        emit(event as unknown as AiEvent)
        if (event.type === 'approval') writes.add(String(event.id))
        if (event.type === 'tool' && event.status === 'done' && writes.has(String(event.id))) announceChange()
        if (event.type === 'done') finished = true
      }
    } catch {
      // Dropped mid-turn; told below.
    }
    if (!finished) {
      emit({
        runId: started.runId,
        type: 'error',
        message: 'The connection to Neo Cloud dropped. The answer is still being written there and will be in the conversation.'
      })
      emit({ runId: started.runId, type: 'done', conversationId: started.conversationId })
    }
  })()

  return { started: true, runId: started.runId, conversationId: started.conversationId, messageId: started.messageId }
}

/**
 * A run that has already finished is not an error to answer or stop: the button was
 * pressed a moment late, and the outcome is the one the stream already reported.
 */
const unlessGone = (error: unknown): void => {
  if (!(error instanceof CloudError && error.status === 404)) throw error
}

/** Allow or decline the change a run is waiting on. */
export async function answerRun(runId: string, toolCallId: string, approved: boolean): Promise<void> {
  await must(api.POST('/v1/assistant/runs/{runId}/answers', {
    params: { path: { runId } },
    body: { toolCallId, approved }
  })).catch(unlessGone)
}

/** Stop a run. Neo Cloud declines anything it was waiting on and closes its stream with `done`. */
export async function cancelRun(runId: string): Promise<void> {
  await must(api.DELETE('/v1/assistant/runs/{runId}', { params: { path: { runId } } })).catch(unlessGone)
}
