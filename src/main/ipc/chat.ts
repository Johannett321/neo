import { BrowserWindow } from 'electron'
import type { AiEvent, Attachment, Workspace } from '@shared/types'
import { q, q1 } from '../db/client'
import { mapAttachment, mapChatMessage, mapConversation, mapWorkspace } from '../db/map'
import { deleteAttachment } from '../lib/attachments'
import { readIcon } from '../lib/icons'
import { cancelRun, respondToRun, startRun } from '../lib/ai/run'
import { handle, remove, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The assistant's channels.
 *
 * `chat:send` is the odd one out in this app: every other channel answers with the
 * thing it produced, and this one answers with an id and then talks over a second,
 * one-way channel for as long as the turn takes. It has to — a reply you can read
 * while it is being written is the whole point, and a confirmation in the middle of
 * one can sit unanswered for minutes.
 */

/** Pushed at every open window: the panel lives in whichever one is in front. */
function broadcast(event: AiEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ai', event)
  }
}

async function attachmentsFor(conversationId: string): Promise<Map<string, Attachment[]>> {
  const rows = await q<any>('SELECT * FROM chat_attachment WHERE conversation_id = $1 ORDER BY created_at', [
    conversationId
  ])
  const byMessage = new Map<string, Attachment[]>()
  for (const row of rows) {
    if (!row.message_id) continue
    const list = byMessage.get(row.message_id) ?? []
    list.push(mapAttachment(row))
    byMessage.set(row.message_id, list)
  }
  return byMessage
}

export function registerChatHandlers(): void {
  handle('chat:list', async ({ workspaceId }) => {
    const rows = await q<any>(
      'SELECT * FROM conversation WHERE workspace_id = $1 ORDER BY updated_at DESC',
      [workspaceId]
    )
    return rows.map(mapConversation)
  })

  handle('chat:get', async ({ id }) => {
    const row = await q1<any>('SELECT * FROM conversation WHERE id = $1', [id])
    if (!row) throw new Error('Conversation not found')
    const messages = await q<any>(
      'SELECT * FROM chat_message WHERE conversation_id = $1 ORDER BY sort_order',
      [id]
    )
    const attachments = await attachmentsFor(id)
    return {
      conversation: mapConversation(row),
      messages: messages.map((m) => mapChatMessage(m, attachments.get(m.id) ?? []))
    }
  })

  handle('chat:rename', async ({ id, title }) => {
    const row = await upsert<any>('conversation', { title: title.trim().slice(0, 120) }, id)
    if (!row) throw new Error('Conversation not found')
    return mapConversation(row)
  })

  handle('chat:delete', async ({ id }) => {
    // The rows go with the conversation by cascade; the files on disk do not.
    const files = await q<{ path: string }>('SELECT path FROM chat_attachment WHERE conversation_id = $1', [id])
    await remove('conversation', id)
    for (const file of files) await deleteAttachment(file.path)
  })

  handle('chat:send', async (input) =>
    startRun({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      text: input.text,
      files: input.files,
      projectId: input.projectId,
      send: broadcast
    })
  )

  handle('chat:respond', async ({ runId, toolUseId, approved }) => {
    respondToRun(runId, toolUseId, approved)
  })

  handle('chat:cancel', async ({ runId }) => {
    cancelRun(runId)
  })

  handle('chat:setKey', async ({ workspaceId, apiKey }) => {
    const row = await upsert<any>('workspace', { aiApiKey: apiKey.trim() }, workspaceId)
    if (!row) throw new Error('Workspace not found')
    const workspace: Workspace = mapWorkspace(row, await readIcon(row.icon_path ?? ''))
    return workspace
  })
}
