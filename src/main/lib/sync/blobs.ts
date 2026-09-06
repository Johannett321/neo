import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { attachmentDir, dataRoot, exec, iconDir, q } from '../../db/client'
import { forgetIcon } from '../icons'
import { blobKey, openBytes, sealBytes, SEAL_OVERHEAD, workspaceKey } from './crypto'
import type { Relay } from './relay'
import { RelayError } from './relay'

/**
 * The files, which the log deliberately does not carry.
 *
 * An operation is a sentence about the work; a photograph is not. Icons, banners,
 * avatars, attachments and recording audio move separately, lazily, and never
 * through the sync server's own process — the client is handed a signed URL and
 * talks to object storage directly.
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

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false)

/* ------------------------------------------------------------------ *
 * Out
 * ------------------------------------------------------------------ */

export async function pushBlobs(
  client: Relay, master: Buffer
): Promise<{ uploaded: number; skipped: number }> {
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
      const sealed = sealBytes(workspaceKey(master, blob.workspaceId), await readFile(blob.path))
      const key = blobKey(master, blob.workspaceId, blob.ref)
      const { uploadUrl } = await client.blobUpload(blob.workspaceId, key, sealed.length)
      await client.putBytes(uploadUrl, sealed)

      await exec(
        `INSERT INTO blob_sync (kind, ref, workspace_id, bytes, uploaded_at)
              VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (kind, ref) DO UPDATE SET uploaded_at = now(), bytes = EXCLUDED.bytes`,
        [blob.kind, blob.ref, blob.workspaceId, sealed.length]
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

export async function pullBlobs(
  client: Relay, master: Buffer
): Promise<{ fetched: number; missing: number }> {
  let fetched = 0
  let missing = 0

  for (const blob of await referenced()) {
    if (await exists(blob.path)) continue

    try {
      const key = blobKey(master, blob.workspaceId, blob.ref)
      const { downloadUrl } = await client.blobDownload(blob.workspaceId, key)
      const opened = openBytes(
        workspaceKey(master, blob.workspaceId), await client.getBytes(downloadUrl)
      )
      await mkdir(dirname(blob.path), { recursive: true })
      await writeFile(blob.path, opened)

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

/** What a sealed copy of a file costs, for the settings pane's arithmetic. */
export const sealedSize = (bytes: number): number => bytes + SEAL_OVERHEAD
