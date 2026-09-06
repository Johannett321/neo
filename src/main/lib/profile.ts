import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { exec, q, q1 } from '../db/client'
import { upsert } from '../ipc/util'

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
    await upsert('person', { name: profile.name, avatarPath: profile.avatarPath }, existing.id)
    return existing.id
  }

  const created = await upsert<{ id: string }>('person', {
    workspaceId,
    name: profile.name,
    avatarPath: profile.avatarPath,
    avatarColor: '#6366f1',
    isMe: true
  })
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
  // A row at a time: each membership is its own fact and needs its own stamp, so a
  // set-based insert would land on other devices as one undifferentiated write.
  const missing = await q<{ person_id: string; project_id: string }>(
    `SELECT me.id AS person_id, p.id AS project_id
       FROM project p
       JOIN person me ON me.workspace_id = p.workspace_id AND me.is_me
      WHERE NOT EXISTS (
        SELECT 1 FROM membership m WHERE m.project_id = p.id AND m.person_id = me.id
      )`
  )
  for (const row of missing) {
    await upsert('membership', { personId: row.person_id, projectId: row.project_id, role: '' })
  }
}

/**
 * What to put in the name field before you have typed anything. A filled field is a
 * thing to correct rather than compose, and the machine already knows this: on macOS
 * `id -F` is the full name out of the directory service. Everything about it is
 * allowed to fail — the account name, and then an empty field, are both fine.
 */
export async function suggestedName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('id', ['-F'], { timeout: 800 })
      const full = stdout.trim()
      if (full) return full
    } catch {
      /* No directory service, or it took too long. The account name will do. */
    }
  }
  try {
    const { username } = userInfo()
    return username ? username.charAt(0).toUpperCase() + username.slice(1) : ''
  } catch {
    return ''
  }
}
