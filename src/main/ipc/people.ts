import type { Membership, Person } from '@shared/types'
import { exec, q } from '../db/client'
import { mapCast, mapPerson, mapPersonProject } from '../db/map'
import { logActivity } from '../lib/activity'
import { deleteIcon, readIcon } from '../lib/icons'
import { ensureMe, ensureMeEverywhere, readProfile, writeProfile } from '../lib/profile'
import { mirrorProject } from '../lib/markdown'
import { handle, pick, upsert } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerPeopleHandlers(): void {
  handle('person:list', async ({ workspaceId, query }) => {
    const term = query?.trim()
    const rows = await q<any>(
      `SELECT p.*, COALESCE(c.n, 0) AS project_count
       FROM person p
       LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM membership m WHERE m.person_id = p.id) c ON true
       WHERE p.workspace_id = $1
       ${term ? 'AND (p.name ILIKE $2 OR p.org ILIKE $2 OR p.email ILIKE $2)' : ''}
       ORDER BY p.is_me DESC, p.name`,
      term ? [workspaceId, `%${term}%`] : [workspaceId]
    )
    return Promise.all(
      rows.map(async (r) => ({
        ...mapPerson(r, await readIcon(r.avatar_path ?? '')),
        projectCount: r.project_count
      }))
    )
  })

  handle('person:get', async ({ id }) => {
    const rows = await q<any>('SELECT * FROM person WHERE id = $1', [id])
    if (!rows[0]) throw new Error('Person not found')
    const projects = await q<any>(
      `SELECT m.*, p.name AS project_name, p.status AS project_status,
              w.name AS workspace_name, w.color AS workspace_color
       FROM membership m
       JOIN project p ON p.id = m.project_id
       JOIN workspace w ON w.id = p.workspace_id
       WHERE m.person_id = $1
       ORDER BY w.sort_order, p.name`,
      [id]
    )
    return {
      person: mapPerson(rows[0], await readIcon(rows[0].avatar_path ?? '')),
      projects: projects.map(mapPersonProject)
    }
  })

  handle('person:save', async (draft) => {
    const fields = pick(draft as Partial<Person>, [
      'workspaceId', 'name', 'org', 'email', 'phone', 'timezone', 'avatarColor', 'avatarPath',
      'howToWorkWith', 'notes'
    ])

    // Replacing a photo should not leave the old file behind.
    let orphan = ''
    if (draft.id && fields.avatarPath !== undefined) {
      const current = await q<any>('SELECT avatar_path FROM person WHERE id = $1', [draft.id])
      const previous = current[0]?.avatar_path
      if (previous && previous !== fields.avatarPath) orphan = previous
    }

    const row = await upsert<any>('person', fields, draft.id)
    if (orphan) await deleteIcon(orphan)
    return mapPerson(row, await readIcon(row.avatar_path ?? ''))
  })

  handle('person:delete', async ({ id }) => {
    const rows = await q<any>('SELECT avatar_path, is_me FROM person WHERE id = $1', [id])
    if (rows[0]?.is_me) throw new Error('You cannot delete yourself. Edit your profile in Settings instead.')
    await exec('DELETE FROM person WHERE id = $1', [id])
    if (rows[0]?.avatar_path) await deleteIcon(rows[0].avatar_path)
  })

  handle('membership:save', async (draft) => {
    const isNew = !draft.id
    const row = await upsert<any>(
      'membership',
      pick(draft as Partial<Membership>, ['personId', 'projectId', 'role', 'note']),
      draft.id
    )
    const joined = await q<any>(
      `SELECT m.*, p.name, p.org, p.email, p.avatar_color, p.avatar_path, p.is_me, p.how_to_work_with
       FROM membership m JOIN person p ON p.id = m.person_id WHERE m.id = $1`,
      [row.id]
    )
    const member = mapCast(joined[0], await readIcon(joined[0].avatar_path ?? ''))
    if (isNew) {
      await logActivity(member.projectId, 'person_added', `${member.name} joined as ${member.role || 'unspecified'}`)
    }
    await mirrorProject(member.projectId)
    return member
  })

  handle('profile:get', async () => {
    const stored = await readProfile()
    return { ...stored, avatar: await readIcon(stored.avatarPath) }
  })

  handle('profile:save', async (patch) => {
    const current = await readProfile()
    const next = {
      name: (patch.name ?? current.name).trim() || 'Me',
      avatarPath: patch.avatarPath ?? current.avatarPath
    }
    await writeProfile(next)
    // Push the change into every workspace's copy of you.
    await ensureMeEverywhere()
    if (current.avatarPath && current.avatarPath !== next.avatarPath) await deleteIcon(current.avatarPath)
    return { ...next, avatar: await readIcon(next.avatarPath) }
  })

  handle('membership:roles', async ({ workspaceId }) => {
    const rows = await q<{ role: string }>(
      `SELECT DISTINCT btrim(part) AS role
       FROM membership m
       JOIN project p ON p.id = m.project_id
       CROSS JOIN LATERAL unnest(string_to_array(m.role, ',')) AS part
       WHERE p.workspace_id = $1 AND btrim(part) <> ''
       ORDER BY role`,
      [workspaceId]
    )
    return rows.map((r) => r.role)
  })

  handle('membership:saveMine', async ({ projectId, role }) => {
    const project = await q<any>('SELECT workspace_id FROM project WHERE id = $1', [projectId])
    if (!project[0]) throw new Error('Project not found')
    const mePersonId = await ensureMe(project[0].workspace_id)
    await exec(
      `INSERT INTO membership (person_id, project_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (person_id, project_id) DO UPDATE SET role = EXCLUDED.role`,
      [mePersonId, projectId, role]
    )
    const joined = await q<any>(
      `SELECT m.*, p.name, p.org, p.email, p.avatar_color, p.avatar_path, p.is_me, p.how_to_work_with
       FROM membership m JOIN person p ON p.id = m.person_id
       WHERE m.person_id = $1 AND m.project_id = $2`,
      [mePersonId, projectId]
    )
    await mirrorProject(projectId)
    return mapCast(joined[0], await readIcon(joined[0].avatar_path ?? ''))
  })

  handle('membership:delete', async ({ id }) => {
    const rows = await q<any>(
      `SELECT p.is_me FROM membership m JOIN person p ON p.id = m.person_id WHERE m.id = $1`,
      [id]
    )
    if (rows[0]?.is_me) {
      throw new Error('You are always on your own projects. Clear your roles instead of removing yourself.')
    }
    await exec('DELETE FROM membership WHERE id = $1', [id])
  })
}
