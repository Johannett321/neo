import type { ActivityKind } from '@shared/types'
import { q1 } from '../db/client'
import { upsert } from '../ipc/util'

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
 *
 * Both writes go through `upsert()`, so the activity line and the clock join the same
 * operation batch as the change they describe. That is what turns "every mutation
 * logs activity" from something each handler has to remember into something a device
 * receiving the batch can rely on: it cannot arrive with the task and without the
 * line about it.
 *
 * Coalescing is a *local* decision, resolved by finding the row first and then
 * writing it by id. Two devices that each coalesce onto their own line simply end up
 * with two lines, which is honest — they were two sittings.
 */
export async function logActivity(
  projectId: string,
  kind: ActivityKind,
  summary: string,
  entityId?: string | null
): Promise<void> {
  const text = summary.slice(0, 300)
  const now = new Date()

  const recent = entityId
    ? await q1<{ id: string }>(
        `SELECT id FROM activity
          WHERE project_id = $1 AND kind = $2 AND entity_id = $3
            AND created_at > now() - interval '30 minutes'
          ORDER BY created_at DESC LIMIT 1`,
        [projectId, kind, entityId]
      )
    : null

  if (recent) {
    await upsert('activity', { summary: text, createdAt: now }, recent.id)
  } else {
    await upsert('activity', {
      projectId,
      kind,
      summary: text,
      entityId: entityId ?? null,
      createdAt: now
    })
  }

  await upsert('project', { lastActivityAt: now }, projectId)
}
