import { exec, q, q1 } from '../db/client'

/**
 * You are one person with one name and one photo, but workspaces are separate areas
 * and a membership has to point at a person inside the workspace it belongs to. So
 * the profile is stored once and mirrored into each workspace as a person row flagged
 * `is_me`. Editing the profile updates every mirror; nothing else has to know.
 */
export interface StoredProfile {
  name: string
  avatarPath: string
}

export async function readProfile(): Promise<StoredProfile> {
  const rows = await q<{ key: string; value: string }>(
    "SELECT key, value FROM setting WHERE key IN ('profileName', 'profileAvatarPath')"
  )
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { name: stored.profileName ?? 'Me', avatarPath: stored.profileAvatarPath ?? '' }
}

export async function writeProfile(profile: StoredProfile): Promise<void> {
  for (const [key, value] of [
    ['profileName', profile.name],
    ['profileAvatarPath', profile.avatarPath]
  ] as const) {
    await exec(
      `INSERT INTO setting (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    )
  }
}

/** Make sure this workspace has a person that is you, and that it matches the profile. */
export async function ensureMe(workspaceId: string): Promise<string> {
  const profile = await readProfile()
  const existing = await q1<{ id: string }>(
    'SELECT id FROM person WHERE workspace_id = $1 AND is_me LIMIT 1',
    [workspaceId]
  )

  if (existing) {
    await exec('UPDATE person SET name = $2, avatar_path = $3 WHERE id = $1', [
      existing.id,
      profile.name,
      profile.avatarPath
    ])
    return existing.id
  }

  const created = await q1<{ id: string }>(
    `INSERT INTO person (workspace_id, name, avatar_path, avatar_color, is_me)
     VALUES ($1, $2, $3, '#6366f1', true) RETURNING id`,
    [workspaceId, profile.name, profile.avatarPath]
  )
  if (!created) throw new Error('Could not create your person record')
  return created.id
}

/** Every workspace gets one, so you can be put on any project without setting up first. */
export async function ensureMeEverywhere(): Promise<void> {
  const workspaces = await q<{ id: string }>('SELECT id FROM workspace')
  for (const workspace of workspaces) await ensureMe(workspace.id)
}

/**
 * Every project is one you created, so you belong on all of them. Run at launch to
 * cover projects made before this existed; safe to repeat, and nothing can remove
 * you afterwards, so it never fights a deliberate choice.
 */
export async function ensureMeOnAllProjects(): Promise<void> {
  await exec(
    `INSERT INTO membership (person_id, project_id, role)
     SELECT me.id, p.id, ''
     FROM project p
     JOIN person me ON me.workspace_id = p.workspace_id AND me.is_me
     WHERE NOT EXISTS (
       SELECT 1 FROM membership m WHERE m.project_id = p.id AND m.person_id = me.id
     )`
  )
}
