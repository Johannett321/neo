import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { attachmentDir, dataRoot, exec, iconDir, q } from '../../db/client'
import { forgetIcon } from '../icons'
import type { Relay } from './relay'
import { RelayError } from './relay'

/**
 * The files, which do not travel as rows.
 *
 * A row is a sentence about the work; a photograph is not. Icons, banners, avatars,
 * attachments and recording audio move separately, lazily, and never through the sync
 * server's own process — the client is handed a signed URL and talks to object
 * storage directly.
 *
 * This is a **reconciler, not a queue**. It asks two questions of what the rows
 * already say, and answers them:
 *
 *   - is a file referenced, present here, and not yet handed over? — upload it
 *   - is a file referenced and *not* present here? — fetch it
 *
 * There is nothing to enqueue, nothing to drain, and nothing that can be lost by
 * crashing half way. It is the shape the recording pipeline already uses, for the
 * same reason: state in rows rather than in memory means a restart costs a pass.
 *
 * The bytes go up as they are. They used to be sealed under the workspace key and
 * named by an HMAC of the filename, so that the server could not recognise a file it
 * had seen elsewhere; with the rows themselves readable there, that bought nothing
 * but a bucket nobody could look inside.
 */

export type BlobKind = 'icon' | 'attachment' | 'segment'

interface Blob {
  kind: BlobKind
  /** The shared name. The same on every device, because the row carrying it syncs. */
  ref: string
  workspaceId: string
  /** Where the bytes sit on this machine. */
  path: string
}

/* ------------------------------------------------------------------ *
 * What the rows say exists
 * ------------------------------------------------------------------ */

/**
 * Every file the database refers to, with the workspace it belongs to.
 *
 * Read out of the rows rather than by walking the folders, and that direction
 * matters: a file on disk that nothing refers to is rubbish `pruneIcons()` will
 * collect, and uploading it would mean paying to store somebody's deleted avatar.
 */
async function referenced(): Promise<Blob[]> {
  const rows = await q<{ kind: BlobKind; ref: string; workspace_id: string }>(
    `SELECT 'icon' AS kind, icon_path AS ref, id AS workspace_id
       FROM workspace WHERE icon_path <> ''
     UNION ALL
     SELECT 'icon', banner_path, id FROM workspace WHERE banner_path <> ''
     UNION ALL
     SELECT 'icon', p.icon_path, p.workspace_id FROM project p WHERE p.icon_path <> ''
     UNION ALL
     SELECT 'icon', pe.avatar_path, pe.workspace_id FROM person pe WHERE pe.avatar_path <> ''
     UNION ALL
     SELECT 'attachment', a.path, c.workspace_id
       FROM chat_attachment a JOIN conversation c ON c.id = a.conversation_id
      WHERE a.path <> ''
     UNION ALL
     SELECT 'attachment', i.path, p.workspace_id
       FROM note_image i JOIN project p ON p.id = i.project_id
      WHERE i.path <> ''
     UNION ALL
     -- A segment is addressed by its recording and its file together: the names are
     -- ordinals, so 0000.webm means nothing without knowing which recording it is in.
     SELECT 'segment', s.recording_id || '/' || s.path, pr.workspace_id
       FROM recording_segment s
       JOIN recording r  ON r.id = s.recording_id
       JOIN meeting m    ON m.id = r.meeting_id
       JOIN project pr   ON pr.id = m.project_id
       JOIN workspace w  ON w.id = pr.workspace_id
      WHERE s.path <> '' AND w.sync_recordings`
  )
  return rows.map((row) => ({
    kind: row.kind,
    ref: row.ref,
    workspaceId: row.workspace_id,
    path: localPath(row.kind, row.ref)
  }))
}

function localPath(kind: BlobKind, ref: string): string {
  if (kind === 'icon') return join(iconDir(), ref)
  if (kind === 'attachment') return join(attachmentDir(), ref)
  return join(dataRoot(), 'recordings', ref)
}

/**
 * What the file is called in the bucket.
 *
 * The name the rows already carry, with the one slash a segment needs turned into a
 * colon: a key may not contain a path, because the workspace's prefix is the whole of
 * the separation between one account's files and another's.
 */
const objectKey = (blob: Blob): string => blob.ref.replace(/\//g, ':')

/**
 * Enough of a content type that a browser opening a presigned URL does something
 * sensible with it, and no more. The extension is all there is to go on, and guessing
 * wrongly costs a download that says `application/octet-stream`.
 */
function contentTypeOf(ref: string): string {
  const ext = extname(ref).toLowerCase()
  const known: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
    '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown'
  }
  return known[ext] ?? 'application/octet-stream'
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false)

/* ------------------------------------------------------------------ *
 * Out
 * ------------------------------------------------------------------ */

export async function pushBlobs(client: Relay): Promise<{ uploaded: number; skipped: number }> {
  const done = new Set(
    (await q<{ kind: string; ref: string }>(
      'SELECT kind, ref FROM blob_sync WHERE uploaded_at IS NOT NULL'
    )).map((row) => `${row.kind}:${row.ref}`)
  )

  let uploaded = 0
  let skipped = 0

  for (const blob of await referenced()) {
    if (done.has(`${blob.kind}:${blob.ref}`)) continue
    if (!(await exists(blob.path))) continue

    try {
      const bytes = await readFile(blob.path)
      const type = contentTypeOf(blob.ref)
      const { uploadUrl } = await client.blobUpload(
        blob.workspaceId, objectKey(blob), bytes.length, type
      )
      await client.putBytes(uploadUrl, bytes, type)

      await exec(
        `INSERT INTO blob_sync (kind, ref, workspace_id, bytes, uploaded_at)
              VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (kind, ref) DO UPDATE SET uploaded_at = now(), bytes = EXCLUDED.bytes`,
        [blob.kind, blob.ref, blob.workspaceId, bytes.length]
      )
      uploaded += 1
    } catch (error) {
      /*
       * Being out of space is not a failure to retry into: it will be out of space
       * next time too. It is recorded as a skip and the pass carries on, so one
       * oversized recording does not stop every icon behind it.
       */
      if (error instanceof RelayError && error.status === 507) {
        skipped += 1
        continue
      }
      throw error
    }
  }
  return { uploaded, skipped }
}

/* ------------------------------------------------------------------ *
 * In
 * ------------------------------------------------------------------ */

export async function pullBlobs(client: Relay): Promise<{ fetched: number; missing: number }> {
  let fetched = 0
  let missing = 0

  for (const blob of await referenced()) {
    if (await exists(blob.path)) continue

    try {
      const { downloadUrl } = await client.blobDownload(blob.workspaceId, objectKey(blob))
      const bytes = await client.getBytes(downloadUrl)
      await mkdir(dirname(blob.path), { recursive: true })
      await writeFile(blob.path, bytes)

      /*
       * The icon cache remembers that this file was absent, and would go on saying so
       * until the app was next opened — an avatar that arrives and does not appear
       * looks exactly like an avatar that did not arrive.
       */
      if (blob.kind === 'icon') forgetIcon(blob.ref)
      fetched += 1
    } catch (error) {
      /*
       * The other device has not uploaded it yet. Perfectly ordinary — the rows move
       * in one pass and the bytes in another — so it is counted and left for the next
       * pass rather than treated as a fault.
       */
      if (error instanceof RelayError && error.status === 404) {
        missing += 1
        continue
      }
      throw error
    }
  }
  return { fetched, missing }
}
