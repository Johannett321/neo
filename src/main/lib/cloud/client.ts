import createClient from 'openapi-fetch'
import { BrowserWindow } from 'electron'
import type { paths } from './schema'
import { clearSession, loadSession } from './session'

/**
 * Neo Cloud, as the main process talks to it.
 *
 * `api` is a typed client generated from the server's OpenAPI contract, so a request
 * that does not match the contract does not compile. The renderer never talks to the
 * server: it calls the same IPC channels it always has, and the handlers in `ipc/`
 * turn each one into a request here. The token stays in this process.
 *
 * Two headers go on every request. The token, obviously. And the time zone, because
 * "due today" means today where the person is sitting and the server has no other way
 * of knowing where that is.
 */

export const DEFAULT_CLOUD_URL = 'https://neo-sync-production.up.railway.app'

/** Neo Cloud, unless a development run has pointed the app at a server of its own. */
export const cloudUrl = (): string =>
  (process.env.NEO_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, '')

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

const zone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * How many requests that change something have succeeded since the app started.
 *
 * Nothing reads it for its value, only for whether it moved: `invokeChannel()` takes it
 * before and after a call so the window is told when the assistant or Claude Desktop
 * wrote something — the same job PGlite's row count did when the database was here.
 */
let writes = 0
export const writeCount = (): number => writes

export const api = createClient<paths>({
  baseUrl: cloudUrl(),
  fetch: (request: Request) => send(request)
})

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  const session = loadSession()
  return {
    'X-Neo-Time-Zone': zone(),
    ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    ...extra
  }
}

async function send(request: Request): Promise<Response> {
  for (const [key, value] of Object.entries(headers())) {
    if (!request.headers.has(key)) request.headers.set(key, value)
  }
  let response: Response
  try {
    response = await fetch(request)
  } catch {
    throw new CloudError(0, 'Neo Cloud cannot be reached. Check the connection and try again.')
  }
  if (response.status === 401 && loadSession() && !request.url.includes('/v1/auth/')) {
    signedOutElsewhere()
  }
  if (response.ok && request.method !== 'GET') writes++
  return response
}

/**
 * The contract's refusals are `{"error": "a sentence"}`, written to be shown. Anything
 * else — a proxy's HTML page, an empty body — is reported by status instead.
 */
/*
 * The answer is typed loosely on purpose. What a handler returns is typed by the IPC
 * contract in `shared/api.ts` — the types the renderer is written against — and the
 * OpenAPI contract was written to match them; requiring the generated types to be
 * assignable to the hand-written ones as well would mean a cast at every call site
 * saying the same thing. The request side stays strictly typed.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export async function must(
  pending: Promise<{ data?: unknown; error?: unknown; response: Response }>
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
): Promise<any> {
  const { data, error, response } = await pending
  if (response.ok) return data
  const sentence = (error as { error?: string } | undefined)?.error
  throw new CloudError(response.status, sentence || `Neo Cloud answered ${response.status}.`)
}

/** Raw bytes to an endpoint that takes a file, answering with the endpoint's JSON. */
export async function upload<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  bytes: Uint8Array
): Promise<T> {
  const url = new URL(cloudUrl() + path)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const response = await send(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  }))
  return readJson<T>(response)
}

/** A stored file or a segment's audio, passed straight through — status, headers and all. */
export async function fetchRaw(path: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<Response> {
  return send(new Request(cloudUrl() + path, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body
  }))
}

export async function readJson<T>(response: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // An empty body is the ordinary answer to a 204.
  }
  if (!response.ok) {
    const sentence = (body as { error?: string } | null)?.error
    throw new CloudError(response.status, sentence || `Neo Cloud answered ${response.status}.`)
  }
  return body as T
}

/**
 * The token stopped working — the device was signed out from another one, or the
 * account was closed. Holding on to it would be pretending this machine is still
 * signed in, so it is forgotten and the window is sent back to the sign-in screen.
 */
function signedOutElsewhere(): void {
  clearSession()
  for (const listener of listeners) listener()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('account', { signedIn: false })
  }
}

const listeners = new Set<() => void>()
export function onSignedOut(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
