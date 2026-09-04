import type { SearchHit } from '@shared/types'
import { q } from '../db/client'
import { handle } from './util'

/* eslint-disable @typescript-eslint/no-explicit-any */
const SEARCH_SQL = /* sql */ `
SELECT 'project' AS kind, p.id, p.id AS project_id, p.name AS title,
       w.name AS subtitle, left(p.summary, 160) AS snippet, w.color AS color, 0 AS rank
FROM project p JOIN workspace w ON w.id = p.workspace_id
WHERE p.workspace_id = $2 AND p.archived_at IS NULL AND (p.name ILIKE $1 OR p.summary ILIKE $1)

UNION ALL
SELECT 'person', pe.id, NULL, pe.name, COALESCE(NULLIF(pe.org, ''), 'No organisation'),
       left(COALESCE(NULLIF(pe.how_to_work_with, ''), pe.notes), 160), pe.avatar_color, 1
FROM person pe
WHERE pe.workspace_id = $2
  AND (pe.name ILIKE $1 OR pe.org ILIKE $1 OR pe.email ILIKE $1 OR pe.how_to_work_with ILIKE $1)

UNION ALL
SELECT 'task', t.id, t.project_id, t.title, p.name,
       left(t.details, 160), w.color, 2
FROM task t JOIN project p ON p.id = t.project_id JOIN workspace w ON w.id = p.workspace_id
WHERE p.workspace_id = $2 AND p.archived_at IS NULL AND (t.title ILIKE $1 OR t.details ILIKE $1)

UNION ALL
SELECT 'note', n.id, n.project_id, COALESCE(NULLIF(n.title, ''), 'Untitled note'), p.name,
       left(n.body, 160), w.color, 3
FROM note n JOIN project p ON p.id = n.project_id JOIN workspace w ON w.id = p.workspace_id
WHERE p.workspace_id = $2 AND p.archived_at IS NULL AND (n.title ILIKE $1 OR n.body ILIKE $1)

UNION ALL
SELECT 'decision', d.id, d.project_id, d.title, p.name || ' · ' || d.decided_on,
       left(d.rationale, 160), w.color, 4
FROM decision d JOIN project p ON p.id = d.project_id JOIN workspace w ON w.id = p.workspace_id
WHERE p.workspace_id = $2 AND p.archived_at IS NULL AND (d.title ILIKE $1 OR d.rationale ILIKE $1 OR d.alternatives ILIKE $1)

UNION ALL
SELECT 'journal', j.id, j.project_id, j.occurred_on, p.name,
       left(j.body, 160), w.color, 5
FROM journal_entry j JOIN project p ON p.id = j.project_id JOIN workspace w ON w.id = p.workspace_id
WHERE p.workspace_id = $2 AND p.archived_at IS NULL AND j.body ILIKE $1

ORDER BY rank, title
LIMIT 40
`

export function registerSearchHandlers(): void {
  handle('search:query', async ({ q: term, workspaceId }) => {
    const needle = term.trim()
    if (needle.length < 2) return []
    const rows = await q<any>(SEARCH_SQL, [`%${needle}%`, workspaceId])
    return rows.map(
      (r): SearchHit => ({
        kind: r.kind,
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        subtitle: r.subtitle ?? '',
        snippet: (r.snippet ?? '').replace(/\s+/g, ' ').trim(),
        color: r.color
      })
    )
  })
}
