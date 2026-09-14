import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { changelogMedia } from '../changelog'
import { fetchRaw } from '../cloud/client'
import { loadSession } from '../cloud/session'

/**
 * How the window shows a stored file without ever holding the token that fetches it.
 *
 * Icons, banners, avatars, pictures in notes and recording audio all live in Neo Cloud.
 * The window is given `neo-media://` addresses for them, and this handler — in the
 * process that holds the token — fetches each one from the server and hands the bytes
 * back. The renderer never sees a URL on the server, and a page loaded in it cannot
 * reach one.
 *
 * Audio is passed through a part at a time: an `<audio>` element asks for the range it
 * is about to play and seeks by asking for another, and the `Range` header goes to the
 * server and the `206` comes back unchanged.
 *
 * Pictures are kept in memory once fetched — a file is named once and never changed,
 * so a copy cannot go stale — and never written to the disk. Signing out forgets them.
 */

export const MEDIA_SCHEME = 'neo-media'

/** Must run before the app is ready, which is why it is not part of the handler. */
export const MEDIA_SCHEME_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}

/** Pictures under this size are remembered; anything larger is fetched each time. */
const CACHE_ITEM_BYTES = 4 * 1024 * 1024
/** And no more than this in all, oldest forgotten first. */
const CACHE_TOTAL_BYTES = 96 * 1024 * 1024

const cache = new Map<string, { bytes: Uint8Array; type: string }>()
let cached = 0

/** Everything fetched on behalf of an account, forgotten when it signs out. */
export function forgetMedia(): void {
  cache.clear()
  cached = 0
}

const STORED_NAME = /^[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/i
const SEGMENT_ID = /^[0-9a-f-]{36}$/i

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const rest = decodeURIComponent(url.pathname.replace(/^\//, ''))

    if (url.hostname === 'changelog') return serveChangelog(rest)
    if (!loadSession()) return new Response('Not found', { status: 404 })

    // `image` is what a note's Markdown has always said; `banner` is what older rows said.
    if (url.hostname === 'file' || url.hostname === 'image' || url.hostname === 'banner') {
      if (!STORED_NAME.test(rest)) return new Response('Not found', { status: 404 })
      return serveFile(rest)
    }
    if (url.hostname === 'segment') {
      if (!SEGMENT_ID.test(rest)) return new Response('Not found', { status: 404 })
      return passThrough(`/v1/recording-segments/${rest}/audio`, request.headers.get('range'))
    }
    return new Response('Not found', { status: 404 })
  })
}

async function serveFile(name: string): Promise<Response> {
  const hit = cache.get(name)
  if (hit) return picture(hit.bytes, hit.type)

  try {
    const response = await fetchRaw(`/v1/files/${encodeURIComponent(name)}`)
    if (!response.ok) return new Response('Not found', { status: 404 })
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength <= CACHE_ITEM_BYTES) remember(name, bytes, type)
    return picture(bytes, type)
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

function picture(bytes: Uint8Array, type: string): Response {
  return new Response(bytes, {
    headers: { 'content-type': type, 'cache-control': 'private, max-age=31536000, immutable' }
  })
}

function remember(name: string, bytes: Uint8Array, type: string): void {
  cache.set(name, { bytes, type })
  cached += bytes.byteLength
  for (const [key, value] of cache) {
    if (cached <= CACHE_TOTAL_BYTES) break
    cache.delete(key)
    cached -= value.bytes.byteLength
  }
}

async function passThrough(path: string, range: string | null): Promise<Response> {
  try {
    const response = await fetchRaw(path, { headers: range ? { Range: range } : {} })
    if (!response.ok && response.status !== 206) {
      return new Response('Not found', { status: response.status === 416 ? 416 : 404 })
    }
    const headers = new Headers()
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(key)
      if (value) headers.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
}

/**
 * An illustration out of the bundled changelog — the one kind of file on this scheme
 * that is not in Neo Cloud, because it shipped with the app. `changelogMedia()` only
 * answers for a path inside the changelog folder, so a `../` reaches a 404.
 */
async function serveChangelog(relative: string): Promise<Response> {
  const path = changelogMedia(relative)
  if (!path) return new Response('Not found', { status: 404 })
  try {
    const bytes = await readFile(path)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': IMAGE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'private, max-age=31536000, immutable'
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
