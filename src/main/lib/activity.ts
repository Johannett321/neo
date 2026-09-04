import type { ActivityKind } from '@shared/types'
import { exec } from '../db/client'

/**
 * Every mutation leaves a trace and bumps the project's activity clock.
 * This is what makes "since you last opened this, three things changed" possible —
 * it costs one insert and requires no discipline from the user.
 */
export async function logActivity(
  projectId: string,
  kind: ActivityKind,
  summary: string
): Promise<void> {
  await exec('INSERT INTO activity (project_id, kind, summary) VALUES ($1, $2, $3)', [
    projectId,
    kind,
    summary.slice(0, 300)
  ])
  await exec('UPDATE project SET last_activity_at = now() WHERE id = $1', [projectId])
}
