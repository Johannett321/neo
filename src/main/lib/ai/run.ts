import OpenAI from 'openai'
import { DEFAULT_MODEL } from '@shared/ai'
import type { AiEvent, AttachmentUpload, Profile } from '@shared/types'
import { q, q1, today } from '../../db/client'
import { invokeChannel, upsert } from '../../ipc/util'
import { readAttachment, shapeOf, storeAttachment } from '../attachments'
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The assistant's turn, from the moment you press send to the moment it stops.
 *
 * The loop lives here, in the main process, for the same reason the database does:
 * it is the only place that has the key, the rows and the filesystem, and none of
 * those should ever be reachable from a renderer. The panel is told what is
 * happening over an event channel and can render a half-written answer; it is never
 * handed the means to write one.
 *
 * The turn is a loop rather than a request. The model answers, or asks for a tool;
 * a tool that only reads is run and handed straight back; a tool that would *change*
 * something stops everything and asks you first, and nothing is written until the
 * panel says yes. That is the whole safety model, and it is deliberately the only
 * one — there is no allowlist of "safe" writes, because a write you did not expect
 * is exactly the one worth stopping for.
 */

/** Enough for a long answer and a dozen tool round trips before anything is cut off. */
const MAX_ITERATIONS = 24

interface Run {
  id: string
  conversationId: string
  cancelled: boolean
  /** Confirmations the loop is currently blocked on, keyed by tool call id. */
  waiting: Map<string, (approved: boolean) => void>
}

const runs = new Map<string, Run>()

export function respondToRun(runId: string, toolUseId: string, approved: boolean): void {
  runs.get(runId)?.waiting.get(toolUseId)?.(approved)
}

export function cancelRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  run.cancelled = true
  // Anything blocked on a confirmation is declined rather than left hanging.
  for (const resolve of run.waiting.values()) resolve(false)
  run.waiting.clear()
}

/* ------------------------------------------------------------------- prompting */

function systemPrompt(context: {
  workspaceName: string
  profileName: string
  projectName?: string
  staleAfterDays: number
}): string {
  return [
    `You are the assistant inside Neo, a personal command centre ${context.profileName || 'its owner'} uses to run several working lives at once — a day job, a company, a client — without holding all of it in their head.`,
    '',
    `Today is ${today()}. You are working inside the "${context.workspaceName}" workspace, and you can only see that one. Never claim to know anything about another workspace; if you are asked about one, say that you would have to be opened in it.`,
    context.projectName ? `The user currently has the "${context.projectName}" project open, so "this project" means that one.` : '',
    '',
    'How to work:',
    '- Look before you answer. You have tools over the real data — the board, the people, the notes, the meeting write-ups, the decision log, the journal and the activity log. Use them rather than guessing, and rather than asking the user for something you could look up.',
    '- Answer in Markdown, and keep it tight. Short paragraphs, lists where a list is genuinely a list. Do not pad, do not restate the question, and do not narrate which tool you are about to use.',
    '- Refer to things by name, never by id. Ids are for tools; a person reads names.',
    '- Dates are always YYYY-MM-DD when you pass them to a tool. Work out what "Friday" or "end of the month" means yourself before calling anything.',
    '',
    'Changing things:',
    '- You can create and change real records, and every one of those is shown to the user for confirmation before it happens. So propose the change by calling the tool — do not ask "shall I?" in prose first, because that makes them answer twice.',
    '- If a call comes back saying it was declined, that was deliberate. Acknowledge it in one line and move on. Do not retry it, and do not try a different tool to achieve the same thing.',
    '- Make one change per tool call, and keep the arguments minimal — only the fields that are actually changing.',
    '- If something is ambiguous — which project, which person, which of two cards — ask, rather than picking.',
    '- Folders are the user’s own filing and nothing reads them back. File a project where you are asked to; never tidy, rename or reorganise folders nobody asked you to touch.',
    '',
    `This app is built on the idea that nothing should need manual upkeep: attention is worked out from overdue work, deadlines and silence (a project nobody has touched for ${context.staleAfterDays} days is stale), never from a status somebody has to remember to set. Do not invent status fields, do not suggest the user maintain one, and do not offer to "update the status" of anything except a project's real status field.`
  ]
    .filter(Boolean)
    .join('\n')
}

/* ------------------------------------------------------------------ persistence */

async function nextSortOrder(conversationId: string): Promise<number> {
  const row = await q1<{ n: number }>(
    'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM chat_message WHERE conversation_id = $1',
    [conversationId]
  )
  return row?.n ?? 0
}

async function saveMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  blocks: unknown[],
  tools: Record<string, unknown> = {}
): Promise<string> {
  const row = await upsert<{ id: string }>('chat_message', {
    conversationId,
    role,
    blocks: JSON.stringify(blocks),
    tools: JSON.stringify(tools),
    sortOrder: await nextSortOrder(conversationId)
  })
  await upsert('conversation', { updatedAt: new Date() }, conversationId)
  return row.id
}

/**
 * Strip the fields the SDK adds and the API will not take back.
 *
 * `responses.stream()` resolves to a *parsed* response: on top of the API's own
 * fields it hangs `parsed_arguments` on every function call and `parsed` on every
 * text part, for the convenience of code using structured outputs. Those belong to
 * the client, not the wire. Sending one back is a hard 400 —
 * `Unknown parameter: input[1].parsed_arguments` — which lands on the *second*
 * request of a turn, the moment the first tool result is replayed, so a conversation
 * with no tool call in it looks perfectly healthy.
 *
 * It runs on the way in and again on the way out, so a conversation stored before
 * this was understood is repaired the next time it is opened rather than being
 * permanently unusable.
 */
export function apiOnly(items: any[]): any[] {
  return items.map((item) => {
    const copy = { ...item }
    delete copy.parsed_arguments
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.map((part: any) => {
        const partCopy = { ...part }
        delete partCopy.parsed
        return partCopy
      })
    }
    return copy
  })
}

/** Everything said so far, in the shape the API wants it back. */
async function replay(conversationId: string): Promise<any[]> {
  const rows = await q<{ blocks: any }>(
    'SELECT blocks FROM chat_message WHERE conversation_id = $1 ORDER BY sort_order',
    [conversationId]
  )
  return apiOnly(
    rows.flatMap((r) => (typeof r.blocks === 'string' ? JSON.parse(r.blocks) : (r.blocks ?? [])))
  )
}

/**
 * A file becomes what the model can actually read: an image as an image, a PDF as a
 * document, and anything textual as text, because a code file pushed through the
 * file path costs more and reads worse than the same characters inline.
 */
async function attachmentContent(
  name: string,
  mime: string,
  path: string
): Promise<Record<string, unknown> | null> {
  const shape = shapeOf(name, mime)
  const bytes = await readAttachment(path)
  if (!shape || !bytes) return null
  if (shape === 'image') {
    return { type: 'input_image', detail: 'auto', image_url: `data:${mime};base64,${bytes.toString('base64')}` }
  }
  if (shape === 'document') {
    return {
      type: 'input_file',
      filename: name,
      file_data: `data:application/pdf;base64,${bytes.toString('base64')}`
    }
  }
  return { type: 'input_text', text: `Attached file — ${name}:\n\n${bytes.toString('utf8')}` }
}

/* ------------------------------------------------------------------------ run */

export interface StartOptions {
  workspaceId: string
  conversationId?: string
  text: string
  files?: AttachmentUpload[]
  projectId?: string
  send: (event: AiEvent) => void
}

/**
 * Opens the conversation, writes the user's turn, and returns immediately with the
 * ids — the answer itself arrives on the event channel. Everything after this point
 * runs detached, because a turn with a confirmation in it can sit waiting for
 * minutes and an IPC call that blocks that long is an IPC call that has hung.
 */
export async function startRun(
  options: StartOptions
): Promise<{ runId: string; conversationId: string; messageId: string }> {
  const workspace = await q1<{ id: string; name: string; ai_api_key: string; ai_model: string }>(
    'SELECT id, name, ai_api_key, ai_model FROM workspace WHERE id = $1',
    [options.workspaceId]
  )
  if (!workspace) throw new Error('Workspace not found')
  if (!workspace.ai_api_key) {
    throw new Error(
      `${workspace.name} has no API key yet. Add one in workspace settings, under Assistant, and the panel will start working.`
    )
  }

  let conversationId = options.conversationId ?? ''
  if (conversationId) {
    const existing = await q1<{ id: string }>(
      'SELECT id FROM conversation WHERE id = $1 AND workspace_id = $2',
      [conversationId, options.workspaceId]
    )
    if (!existing) throw new Error('That conversation is not in this workspace.')
  } else {
    const created = await upsert<{ id: string }>('conversation', {
      workspaceId: options.workspaceId
    })
    conversationId = created.id
  }

  // Files are written to disk before the turn starts, so a failed request does not
  // lose what was dropped in — it is still attached when the message is sent again.
  const content: Record<string, unknown>[] = []
  const stored: { id: string; name: string; mime: string; path: string }[] = []
  for (const file of options.files ?? []) {
    if (!shapeOf(file.name, file.mime)) {
      throw new Error(`${file.name} is not a kind of file the assistant can read.`)
    }
    const { path, bytes } = await storeAttachment(file.name, file.data)
    const row = await upsert<{ id: string }>('chat_attachment', {
      conversationId,
      name: file.name,
      mime: file.mime,
      bytes,
      path
    })
    stored.push({ id: row.id, name: file.name, mime: file.mime, path })
  }
  for (const file of stored) {
    const block = await attachmentContent(file.name, file.mime, file.path)
    if (block) content.push(block)
  }
  if (options.text.trim() || content.length === 0) {
    content.push({ type: 'input_text', text: options.text })
  }

  const messageId = await saveMessage(conversationId, 'user', [{ role: 'user', content }])
  if (stored.length) {
    for (const file of stored) await upsert('chat_attachment', { messageId }, file.id)
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const run: Run = { id: runId, conversationId, cancelled: false, waiting: new Map() }
  runs.set(runId, run)

  void loop(run, {
    apiKey: workspace.ai_api_key,
    model: workspace.ai_model || DEFAULT_MODEL,
    workspaceId: options.workspaceId,
    workspaceName: workspace.name,
    projectId: options.projectId,
    send: options.send
  })
    .catch((error: unknown) => {
      options.send({ runId, type: 'error', message: describe(error) })
    })
    .finally(() => {
      runs.delete(runId)
      options.send({ runId, type: 'done', conversationId })
    })

  return { runId, conversationId, messageId }
}

function describe(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) {
    return 'That API key was rejected. Check it in workspace settings, under Assistant.'
  }
  if (error instanceof OpenAI.RateLimitError) {
    return 'OpenAI is rate limiting this key. Wait a moment and try again.'
  }
  if (error instanceof OpenAI.NotFoundError) {
    return 'That model is not available on this key. Pick another in workspace settings, under Assistant.'
  }
  if (error instanceof OpenAI.APIError) return `OpenAI returned ${error.status}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

interface LoopContext {
  apiKey: string
  model: string
  workspaceId: string
  workspaceName: string
  projectId?: string
  send: (event: AiEvent) => void
}

async function loop(run: Run, ctx: LoopContext): Promise<void> {
  const client = new OpenAI({ apiKey: ctx.apiKey })
  const toolContext: ToolContext = { workspaceId: ctx.workspaceId, projectId: ctx.projectId }

  const profile = await invokeChannel('profile:get').catch(() => ({ name: '' }) as Profile)
  const settings = await invokeChannel('settings:get')
  const projectName = ctx.projectId
    ? (await q1<{ name: string }>('SELECT name FROM project WHERE id = $1', [ctx.projectId]))?.name
    : undefined

  const instructions = systemPrompt({
    workspaceName: ctx.workspaceName,
    profileName: profile.name,
    projectName,
    staleAfterDays: settings.staleAfterDays
  })

  const tools = TOOLS.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Off deliberately: strict mode forbids the loose "id or name" arguments that
    // make these tools usable, and every one of them validates its own input anyway.
    strict: false
  }))

  let input = await replay(run.conversationId)

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (run.cancelled) return

    const stream = client.responses.stream({
      model: ctx.model,
      instructions,
      input,
      tools,
      // Nothing is kept on OpenAI's side. The conversation lives in the same folder
      // as everything else this app owns, and is resent in full each turn.
      store: false
    })

    stream.on('response.output_text.delta', (event) => {
      if (!run.cancelled) ctx.send({ runId: run.id, type: 'text', delta: event.delta })
    })

    const response = await stream.finalResponse()
    if (run.cancelled) return

    const output = apiOnly(response.output ?? [])
    const calls = output.filter((item: any) => item.type === 'function_call')

    // The assistant's turn is saved whether or not it asked for anything, so a
    // conversation reopened mid-thought replays exactly what the model said.
    const records: Record<string, unknown> = {}
    const results: any[] = []

    for (const call of calls as any[]) {
      const tool = TOOLS_BY_NAME.get(call.name)
      if (!tool) {
        records[call.call_id] = {
          name: call.name,
          label: call.name,
          status: 'error',
          detail: 'No such tool.'
        }
        results.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({ error: `There is no tool called ${call.name}.` })
        })
        continue
      }

      let args: Record<string, unknown> = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        records[call.call_id] = {
          name: tool.name,
          label: tool.name,
          status: 'error',
          detail: 'Arguments were not valid JSON.'
        }
        results.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({ error: 'Your arguments were not valid JSON. Send them again.' })
        })
        continue
      }

      /*
       * The confirmation line is built *before* anything is asked, and building it
       * resolves the arguments — so a name that matches nothing, or matches two
       * things, is caught here and comes back as an error rather than as a dialog
       * asking you to approve something nonsensical.
       */
      let label = tool.name
      if (tool.writes) {
        try {
          label = await tool.summary!(args, toolContext)
        } catch (error) {
          records[call.call_id] = {
            name: tool.name,
            label: tool.name,
            status: 'error',
            detail: describe(error)
          }
          results.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({ error: describe(error) })
          })
          continue
        }

        const approved = await ask(run, ctx, call.call_id, tool.name, label)
        if (!approved) {
          records[call.call_id] = {
            name: tool.name,
            label,
            status: 'declined',
            detail: 'You declined this.'
          }
          results.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({
              declined: true,
              message: 'The user declined this change. Nothing was written. Do not try it again.'
            })
          })
          continue
        }
      } else {
        label = readLabel(tool.name, args)
      }

      ctx.send({ runId: run.id, type: 'tool', id: call.call_id, name: tool.name, label, status: 'running', detail: '' })

      try {
        const value = await tool.run(args, toolContext)
        records[call.call_id] = { name: tool.name, label, status: 'done', detail: '' }
        ctx.send({ runId: run.id, type: 'tool', id: call.call_id, name: tool.name, label, status: 'done', detail: '' })
        results.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(value ?? { ok: true })
        })
      } catch (error) {
        const detail = describe(error)
        records[call.call_id] = { name: tool.name, label, status: 'error', detail }
        ctx.send({ runId: run.id, type: 'tool', id: call.call_id, name: tool.name, label, status: 'error', detail })
        results.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({ error: detail })
        })
      }
    }

    await saveMessage(run.conversationId, 'assistant', output, records)
    if (results.length === 0) {
      await nameConversation(client, ctx, run)
      return
    }
    await saveMessage(run.conversationId, 'user', results)
    input = [...input, ...output, ...results]
  }

  ctx.send({
    runId: run.id,
    type: 'error',
    message: 'The assistant went round too many times without settling on an answer. Ask again, more narrowly.'
  })
}

/** What a read shows in the transcript: the tool, and the one argument worth seeing. */
function readLabel(name: string, args: Record<string, unknown>): string {
  const subject = args.project ?? args.person ?? args.query ?? args.kind ?? ''
  const verbs: Record<string, string> = {
    list_projects: 'Read the projects',
    get_project: 'Read',
    today: 'Read what is due',
    search: 'Searched for',
    list_tasks: 'Read the tasks',
    list_people: 'Read the people',
    get_person: 'Read',
    get_document: 'Read the',
    recent_activity: 'Read the activity log'
  }
  const verb = verbs[name] ?? name
  return subject ? `${verb} ${String(subject)}` : verb
}

/**
 * Stop and ask. The loop does not continue until the panel answers, and a run that
 * is cancelled while a question is on screen is answered as a decline.
 */
function ask(
  run: Run,
  ctx: LoopContext,
  toolUseId: string,
  name: string,
  label: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const once = (approved: boolean): void => {
      if (settled) return
      settled = true
      run.waiting.delete(toolUseId)
      resolve(approved)
    }
    run.waiting.set(toolUseId, once)
    if (run.cancelled) return once(false)
    ctx.send({ runId: run.id, type: 'approval', id: toolUseId, name, label, detail: '' })
  })
}

/**
 * A conversation names itself after the first exchange, rather than being called
 * "New chat" forever or making you name it before you know what it is about.
 */
async function nameConversation(client: OpenAI, ctx: LoopContext, run: Run): Promise<void> {
  const current = await q1<{ title: string }>('SELECT title FROM conversation WHERE id = $1', [
    run.conversationId
  ])
  if (current?.title) return

  const transcript = (await replay(run.conversationId))
    .flatMap((item: any) => {
      if (item.role === 'user') {
        return (item.content ?? [])
          .filter((c: any) => c.type === 'input_text')
          .map((c: any) => `User: ${c.text}`)
      }
      if (item.type === 'message') {
        return (item.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => `Assistant: ${c.text}`)
      }
      return []
    })
    .join('\n')
    .slice(0, 4000)

  if (!transcript.trim()) return

  try {
    const response = await client.responses.create({
      model: ctx.model,
      instructions:
        'Name this conversation in three to five words, as a plain noun phrase describing what it is about. No quotes, no trailing punctuation, no "chat about". Reply with the title and nothing else.',
      input: transcript,
      store: false
    })
    const title = (response.output_text ?? '').trim().replace(/^["'“”]|["'“”.]$/g, '').slice(0, 80)
    if (!title) return
    await upsert('conversation', { title }, run.conversationId)
    ctx.send({ runId: run.id, type: 'title', conversationId: run.conversationId, title })
  } catch {
    // A conversation with no name is a cosmetic problem; it must never fail the turn.
  }
}
