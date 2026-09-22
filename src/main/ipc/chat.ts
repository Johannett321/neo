import { BrowserWindow } from 'electron'
import type { AiEvent } from '@shared/types'
import { api, must } from '../lib/cloud/client'
import { answerRun, cancelRun, startRun } from '../lib/cloud/assistant'
import { messageOf } from '../lib/cloud/documents'
import { handle } from './util'

/**
 * The assistant's channels.
 *
 * The conversations and the run loop both live in Neo Cloud. `chat:send` is the odd one
 * out in this app: it answers with an id and then talks over a second, one-way channel
 * for as long as the turn takes — main reads the run's server-sent events and relays
 * each one on `ai`, because a reply you can read while it is written is the whole point,
 * and a confirmation in the middle of one can sit unanswered for minutes.
 */

/** Pushed at every open window: the panel lives in whichever one is in front. */
function broadcast(event: AiEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ai', event)
  }
}

export function registerChatHandlers(): void {
  handle('chat:list', ({ workspaceId }) =>
    must(api.GET('/v1/conversations', { params: { query: { workspaceId } } })))

  handle('chat:get', async ({ id }) => {
    const { conversation, messages } = await must(api.GET('/v1/conversations/{id}', { params: { path: { id } } }))
    return { conversation, messages: messages.map(messageOf) }
  })

  handle('chat:rename', ({ id, title }) =>
    must(api.PATCH('/v1/conversations/{id}', {
      params: { path: { id } },
      body: { title: title.trim().slice(0, 120) }
    })))

  handle('chat:delete', async ({ id }) => {
    await must(api.DELETE('/v1/conversations/{id}', { params: { path: { id } } }))
  })

  handle('chat:send', (input) => startRun(input, broadcast))

  handle('chat:respond', ({ runId, toolUseId, approved }) => answerRun(runId, toolUseId, approved))

  handle('chat:cancel', ({ runId }) => cancelRun(runId))
}
