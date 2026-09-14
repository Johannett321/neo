import { BrowserWindow } from 'electron'
import type { RecordingEvent } from '@shared/types'
import { announceChange } from '../changes'
import { cloudUrl, headers } from './client'
import { loadSession } from './session'

/**
 * Hearing about changes made somewhere else.
 *
 * One server-sent event stream per device, for as long as the app is signed in. A
 * `changed` event means another device — or the recording pipeline — wrote something,
 * and the window empties its cache exactly as it does after a click of its own. A
 * `recording` event says a recording moved along, which the meeting page listens for.
 *
 * The loop is the feature and the connection is the detail: a laptop closes, a proxy
 * times out, the server is redeployed, and each of those ends the stream. It is
 * reopened with backoff up to thirty seconds, and on reopening the window is told to
 * refetch, because whatever changed while it was gone was said to nobody.
 */

const RETRY_MS = 1_000
const RETRY_CEILING_MS = 30_000

let controller: AbortController | null = null

export function startEvents(): void {
  if (controller) return
  const mine = new AbortController()
  controller = mine

  void (async () => {
    let backoff = RETRY_MS
    let first = true
    while (!mine.signal.aborted && loadSession()) {
      try {
        const response = await fetch(`${cloudUrl()}/v1/events`, {
          headers: { ...headers(), Accept: 'text/event-stream' },
          signal: mine.signal
        })
        if (!response.ok || !response.body) throw new Error(`The event stream answered ${response.status}.`)
        backoff = RETRY_MS
        if (!first) announceChange()
        first = false
        await read(response.body, mine.signal)
      } catch (error) {
        if (process.env.PM_TRACE_SYNC && !mine.signal.aborted) console.error('The event stream ended:', error)
      }
      if (mine.signal.aborted) break
      await nap(backoff, mine.signal)
      backoff = Math.min(backoff * 2, RETRY_CEILING_MS)
    }
    if (controller === mine) controller = null
  })()
}

export function stopEvents(): void {
  controller?.abort()
  controller = null
}

async function read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n\n')
    while (cut !== -1) {
      dispatch(buffer.slice(0, cut))
      buffer = buffer.slice(cut + 2)
      cut = buffer.indexOf('\n\n')
    }
  }
}

function dispatch(event: string): void {
  let name = 'message'
  let data = ''
  for (const line of event.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (name === 'changed') {
    announceChange()
  } else if (name === 'recording') {
    try {
      const parsed = JSON.parse(data) as { recordingId: string; meetingId: string; type?: string }
      const payload: RecordingEvent = {
        type: parsed.type === 'interrupted' ? 'interrupted' : 'changed',
        recordingId: parsed.recordingId,
        meetingId: parsed.meetingId
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('recording', payload)
      }
      // What the pipeline wrote is data like any other: the meeting's write-up, its to-dos.
      announceChange()
    } catch {
      // A malformed event is not worth ending a connection over.
    }
  }
}

function nap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    timeout.unref?.()
  })
}
