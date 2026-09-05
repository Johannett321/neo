import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { markdownDir, q } from '../db/client'

/**
 * The database is the index; these files are the durable copy.
 * If this app is ever abandoned, the writing that matters — notes, decisions,
 * journal, the current state of each project — survives as plain Markdown that
 * any editor opens. Structured data is covered by the JSON export instead.
 */

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'untitled'

const safeDir = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '-').trim() || 'untitled'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function writeProjectFiles(root: string, project: any): Promise<number> {
  const dir = join(root, safeDir(project.workspace_name), safeDir(project.name))
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  let files = 0

  const [links, cast, notes, decisions, journal, tasks, meetings] = await Promise.all([
    q<any>('SELECT * FROM link WHERE project_id = $1 ORDER BY sort_order', [project.id]),
    q<any>(
      `SELECT m.role, m.note, p.name, p.org, p.how_to_work_with
       FROM membership m JOIN person p ON p.id = m.person_id
       WHERE m.project_id = $1 ORDER BY p.name`,
      [project.id]
    ),
    q<any>('SELECT * FROM note WHERE project_id = $1 ORDER BY created_at DESC', [project.id]),
    q<any>('SELECT * FROM decision WHERE project_id = $1 ORDER BY decided_on DESC', [project.id]),
    q<any>('SELECT * FROM journal_entry WHERE project_id = $1 ORDER BY occurred_on DESC', [project.id]),
    q<any>("SELECT * FROM task WHERE project_id = $1 AND status = 'open' ORDER BY due_date NULLS LAST", [
      project.id
    ]),
    q<any>(
      `SELECT m.*,
              COALESCE(a.names, '') AS attendee_names,
              COALESCE(t.todos, '') AS todo_lines
       FROM meeting m
       LEFT JOIN LATERAL (
         SELECT string_agg(pe.name, ', ' ORDER BY pe.name) AS names
         FROM meeting_attendee ma JOIN person pe ON pe.id = ma.person_id
         WHERE ma.meeting_id = m.id
       ) a ON true
       LEFT JOIN LATERAL (
         SELECT string_agg(
                  '- [' || CASE WHEN COALESCE(tk.status = 'done', mt.done) THEN 'x' ELSE ' ' END || '] '
                  || mt.text
                  || CASE WHEN mt.task_id IS NULL THEN '' ELSE ' — on the board' END,
                  E'\\n' ORDER BY mt.sort_order, mt.created_at
                ) AS todos
         FROM meeting_todo mt
         LEFT JOIN task tk ON tk.id = mt.task_id
         WHERE mt.meeting_id = m.id
       ) t ON true
       WHERE m.project_id = $1
       ORDER BY m.occurred_on DESC`,
      [project.id]
    )
  ])

  const overview = [
    `# ${project.name}`,
    '',
    `**Workspace:** ${project.workspace_name}  `,
    `**My role:** ${project.my_role}  `,
    `**Status:** ${project.status}`,
    project.summary ? `\n${project.summary}` : '',
    '',
    '## Cast',
    cast.length
      ? cast
          .map(
            (c) =>
              `- **${c.name}** — ${c.role || 'no role set'}${c.org ? ` (${c.org})` : ''}` +
              `${c.how_to_work_with ? `\n  - ${c.how_to_work_with}` : ''}`
          )
          .join('\n')
      : '_Nobody recorded._',
    '',
    '## Links',
    links.length ? links.map((l) => `- [${l.label}](${l.url}) — ${l.kind}`).join('\n') : '_None._',
    '',
    '## Open items',
    tasks.length
      ? tasks
          .map((t) => `- [ ] ${t.title}${t.due_date ? ` — due ${t.due_date}` : ''}` +
            (t.kind === 'delegated' ? ' _(delegated)_' : ''))
          .join('\n')
      : '_Nothing open._',
    ''
  ].join('\n')

  await writeFile(join(dir, '_overview.md'), overview, 'utf8')
  files++

  if (notes.length) {
    await mkdir(join(dir, 'notes'), { recursive: true })
    for (const n of notes) {
      const body = `# ${n.title || 'Untitled note'}\n\n_${new Date(n.created_at).toISOString().slice(0, 10)}_\n\n${n.body}\n`
      await writeFile(join(dir, 'notes', `${slug(n.title || 'note')}-${String(n.id).slice(0, 8)}.md`), body, 'utf8')
      files++
    }
  }

  if (decisions.length) {
    await mkdir(join(dir, 'decisions'), { recursive: true })
    for (const d of decisions) {
      const body = [
        `# ${d.title}`,
        '',
        `**Decided:** ${d.decided_on}${d.decided_by ? ` by ${d.decided_by}` : ''}`,
        '',
        '## Why',
        d.rationale || '_Not recorded._',
        '',
        '## Alternatives rejected',
        d.alternatives || '_Not recorded._',
        ''
      ].join('\n')
      await writeFile(join(dir, 'decisions', `${d.decided_on}-${slug(d.title)}.md`), body, 'utf8')
      files++
    }
  }

  if (meetings.length) {
    await mkdir(join(dir, 'meetings'), { recursive: true })
    for (const m of meetings) {
      const body = [
        `# ${m.title || 'Meeting'}`,
        '',
        `**When:** ${m.occurred_on}`,
        `**Present:** ${m.attendee_names || '_Not recorded._'}`,
        '',
        '## Notes',
        m.body || '_None._',
        '',
        '## To do',
        m.todo_lines || '_None._',
        ''
      ].join('\n')
      await writeFile(join(dir, 'meetings', `${m.occurred_on}-${slug(m.title || 'meeting')}.md`), body, 'utf8')
      files++
    }
  }

  if (journal.length) {
    await mkdir(join(dir, 'journal'), { recursive: true })
    const byDate = new Map<string, string[]>()
    for (const j of journal) {
      const list = byDate.get(j.occurred_on) ?? []
      list.push(j.body)
      byDate.set(j.occurred_on, list)
    }
    for (const [date, entries] of byDate) {
      await writeFile(join(dir, 'journal', `${date}.md`), `# ${date}\n\n${entries.join('\n\n---\n\n')}\n`, 'utf8')
      files++
    }
  }

  return files
}

const PROJECT_ROW = /* sql */ `
SELECT p.*, w.name AS workspace_name
FROM project p JOIN workspace w ON w.id = p.workspace_id
`

/** Refresh one project's folder. Called after any mutation that changes its prose. */
export async function mirrorProject(projectId: string): Promise<void> {
  const rows = await q<any>(`${PROJECT_ROW} WHERE p.id = $1`, [projectId])
  if (!rows[0]) return
  await writeProjectFiles(markdownDir(), rows[0])
}

/** Full rebuild — also clears folders left behind by renames and deletions. */
export async function mirrorAll(): Promise<{ files: number; dir: string }> {
  const root = markdownDir()
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const projects = await q<any>(`${PROJECT_ROW} ORDER BY w.sort_order, p.name`)
  let files = 0
  for (const p of projects) files += await writeProjectFiles(root, p)
  await writeFile(
    join(root, 'README.md'),
    [
      '# Neo export',
      '',
      'A plain-Markdown mirror of every project, written automatically.',
      'The app treats these files as output — edit them freely, but the app will overwrite',
      'them on its next write. The database in `../db` is the source of truth.',
      '',
      `_Last rebuilt ${new Date().toLocaleString()}_`,
      ''
    ].join('\n'),
    'utf8'
  )
  return { files: files + 1, dir: root }
}
