import { protocol } from 'electron'
import { Readable } from 'node:stream'
import { q1 } from '../../db/client'
import { readSegmentStream, segmentBytes } from './store'

/**
 * How the renderer hears the audio without being able to reach the disk.
 *
 * A recording is far too big to hand across the IPC bridge as bytes, and an audio
 * element that has the whole file in memory cannot be seeked into cheaply anyway.
 * So main serves the segments over a scheme of its own, honouring range requests,
 * which is exactly what an `<audio>` element wants: it asks for the part it is about
 * to play and seeks by asking for a different part.
 *
 * The renderer never learns a path. It asks for a segment by id, and this looks the
 * id up in the database and serves the file that row names — so the only files
 * reachable through this scheme are files this app wrote, whatever URL is typed.
 */

export const MEDIA_SCHEME = 'neo-media'

export const segmentUrl = (segmentId: string): string => `${MEDIA_SCHEME}://segment/${segmentId}`

/** Must run before the app is ready, which is why it is not part of the handler. */
export const MEDIA_SCHEME_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}

const RANGE = /^bytes=(\d*)-(\d*)$/

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'segment') return new Response('Not found', { status: 404 })

    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 })

    const row = await q1<{ path: string; recording_id: string; mime: string }>(
      `SELECT s.path, s.recording_id, r.mime
       FROM recording_segment s JOIN recording r ON r.id = s.recording_id
       WHERE s.id = $1`,
      [id]
    )
    // An empty path is a segment whose audio has been deleted on purpose. It is
    // gone, not missing, and 404 is the honest answer either way.
    if (!row?.path) return new Response('Not found', { status: 404 })

    const type = row.mime || 'audio/webm'

    try {
      const total = await segmentBytes(row.recording_id, row.path)
      if (total === 0) return new Response('Not found', { status: 404 })

      const match = RANGE.exec(request.headers.get('range') ?? '')
      if (!match) {
        const { stream } = await readSegmentStream(row.recording_id, row.path)
        return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
          status: 200,
          headers: {
            'content-type': type,
            'content-length': String(total),
            'accept-ranges': 'bytes'
          }
        })
      }

      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
      if (!Number.isFinite(start) || start >= total || end < start) {
        return new Response('', { status: 416, headers: { 'content-range': `bytes */${total}` } })
      }
      const { stream } = await readSegmentStream(row.recording_id, row.path, start, end)
      return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
