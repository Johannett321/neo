import type { ActivityKind } from '@shared/types'
import { exec, q } from '../db/client'

/**
 * Every mutation leaves a trace and bumps the project's activity clock.
 * This is what makes "since you last opened this, three things changed" possible —
 * it costs one insert and requires no discipline from the user.
 *
 * `entityId` is for things that are edited rather than performed. A note saves itself
 * every few seconds while it is being written, and forty identical lines would drown
 * the very brief the log exists to produce, so a line about the same entity written
 * within the last half hour is refreshed in place instead of repeated. The summary is
 * rewritten too, so renaming a note while writing it does not leave the log describing
 * the title it used to have. Anything without an `entityId` always inserts.
 */
export async function logActivity(
  projectId: string,
  kind: ActivityKind,
  summary: string,
  entityId?: string | null
): Promise<void> {
  const text = summary.slice(0, 300)
  let coalesced = false

  if (entityId) {
    const hit = await q<{ id: string }>(
      `UPDATE activity SET summary = $1, created_at = now()
        WHERE id = (SELECT id FROM activity
                     WHERE project_id = $2 AND kind = $3 AND entity_id = $4
                       AND created_at > now() - interval '30 minutes'
                     ORDER BY created_at DESC LIMIT 1)
        RETURNING id`,
      [text, projectId, kind, entityId]
    )
    coalesced = hit.length > 0
  }

  if (!coalesced) {
    await exec('INSERT INTO activity (project_id, kind, summary, entity_id) VALUES ($1, $2, $3, $4)', [
      projectId,
      kind,
      text,
      entityId ?? null
    ])
  }

  await exec('UPDATE project SET last_activity_at = now() WHERE id = $1', [projectId])
}
