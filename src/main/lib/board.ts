import { exec, q, q1 } from '../db/client'

/** What a new project's board looks like before anyone changes it. */
export const DEFAULT_COLUMNS: { name: string; isDone: boolean }[] = [
  { name: 'To do', isDone: false },
  { name: 'In progress', isDone: false },
  { name: 'In review', isDone: false },
  { name: 'Done', isDone: true }
]

/** Give a project the default board if it has none. Safe to call repeatedly. */
export async function ensureColumns(projectId: string): Promise<void> {
  const existing = await q1<{ n: number }>(
    'SELECT count(*)::int AS n FROM board_column WHERE project_id = $1',
    [projectId]
  )
  if (existing && existing.n > 0) return
  for (const [index, column] of DEFAULT_COLUMNS.entries()) {
    await exec(
      'INSERT INTO board_column (project_id, name, sort_order, is_done) VALUES ($1, $2, $3, $4)',
      [projectId, column.name, index, column.isDone]
    )
  }
}

export async function ensureColumnsEverywhere(): Promise<void> {
  const projects = await q<{ id: string }>('SELECT id FROM project')
  for (const project of projects) await ensureColumns(project.id)
}

/** The column a card should sit in when nothing else is specified. */
export async function firstColumnId(projectId: string): Promise<string | null> {
  const row = await q1<{ id: string }>(
    'SELECT id FROM board_column WHERE project_id = $1 ORDER BY sort_order, created_at LIMIT 1',
    [projectId]
  )
  return row?.id ?? null
}

export async function doneColumnId(projectId: string): Promise<string | null> {
  const row = await q1<{ id: string }>(
    `SELECT id FROM board_column WHERE project_id = $1 AND is_done
     ORDER BY sort_order DESC LIMIT 1`,
    [projectId]
  )
  return row?.id ?? null
}
