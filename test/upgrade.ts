import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { __dataDir } from 'electron'
import { initDb, orphanedForeignKeys, q } from '../src/main/db/client'
import { ensureMeEverywhere } from '../src/main/lib/profile'

/**
 * Upgrades an existing database in place. This reproduces the shape a database had
 * before workspaces became separate areas — no workspace on people, no icons, no
 * board stage, and a meeting that was still a form with an agenda, a where, a time
 * and a slab of text called "actions" — and asserts the app can still open it.
 *
 * The failure this guards against is subtle: PostgreSQL parses every statement in a
 * multi-statement batch up front, so an UPDATE referencing a column that an ALTER in
 * the same batch is about to add fails to parse. Migrations must run one at a time.
 */
const OLD_SCHEMA = `
CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6366f1',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  my_role text NOT NULL DEFAULT 'pm',
  status text NOT NULL DEFAULT 'active',
  is_pinned boolean NOT NULL DEFAULT false,
  current_state text NOT NULL DEFAULT '',
  next_action text NOT NULL DEFAULT '',
  open_questions text NOT NULL DEFAULT '',
  last_opened_at timestamptz,
  previous_opened_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE TABLE lane (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, org text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '', timezone text NOT NULL DEFAULT '',
  avatar_color text NOT NULL DEFAULT '#64748b',
  how_to_work_with text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT '', is_escalation boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, project_id)
);
CREATE TABLE task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  lane_id uuid REFERENCES lane(id) ON DELETE SET NULL,
  title text NOT NULL, details text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'task', status text NOT NULL DEFAULT 'open',
  due_date text, waiting_on_person_id uuid REFERENCES person(id) ON DELETE SET NULL,
  waiting_since text, completed_at timestamptz, sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL, rationale text NOT NULL DEFAULT '',
  alternatives text NOT NULL DEFAULT '', decided_by text NOT NULL DEFAULT '',
  decided_on text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label text NOT NULL, url text NOT NULL, kind text NOT NULL DEFAULT 'other',
  sort_order integer NOT NULL DEFAULT 0
);
CREATE TABLE journal_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '', occurred_on text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL, summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meeting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '', occurred_on text NOT NULL,
  starts_at text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '',
  agenda text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  actions text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE setting (key text PRIMARY KEY, value text NOT NULL);
`

const ok = (label: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

async function main(): Promise<void> {
  const dir = join(__dataDir, 'Neo', 'db')
  mkdirSync(dir, { recursive: true })
  const legacy = new PGlite(dir)
  await legacy.waitReady
  await legacy.exec(OLD_SCHEMA)
  await legacy.exec(`
    INSERT INTO workspace (name, color, sort_order) VALUES ('Day job', '#6366f1', 0), ('My company', '#10b981', 1);
    INSERT INTO person (name, org) VALUES ('Legacy Person', 'Acme'), ('Another Person', 'Acme');
  `)
  const wsRow = await legacy.query<{ id: string }>("SELECT id FROM workspace WHERE name = 'Day job'")
  const workspaceId = wsRow.rows[0]!.id
  await legacy.query(
    `INSERT INTO project (workspace_id, name, summary) VALUES ($1, 'Legacy project', 'Made before the upgrade')`,
    [workspaceId]
  )
  const projectRow = await legacy.query<{ id: string }>('SELECT id FROM project')
  await legacy.query(`INSERT INTO lane (project_id, name) VALUES ($1, 'An old worklane')`, [projectRow.rows[0]!.id])
  const laneRow = await legacy.query<{ id: string }>('SELECT id FROM lane')
  await legacy.query(
    `INSERT INTO task (project_id, lane_id, title, status)
     VALUES ($1, $2, 'An old finished task', 'done'), ($1, $2, 'An old open task', 'open')`,
    [projectRow.rows[0]!.id, laneRow.rows[0]!.id]
  )
  await legacy.query(
    `INSERT INTO activity (project_id, kind, summary) VALUES ($1, 'note', 'Note: an old line')`,
    [projectRow.rows[0]!.id]
  )
  await legacy.query(
    `INSERT INTO meeting (project_id, title, occurred_on, starts_at, location, agenda, body, actions)
     VALUES ($1, 'An old meeting', '2024-01-15', '09:30', 'Room 4',
             'First thing' || chr(10) || 'Second thing',
             'What was said.',
             'Me: chase the ruling' || chr(10) || '- Priya: error states' || chr(10) || '')`,
    [projectRow.rows[0]!.id]
  )
  await legacy.close()
  console.log('Built a database in the pre-workspace shape.\n')

  // The real thing: open that database with the current code.
  await initDb()

  const people = await q<{ name: string; workspace_id: string | null }>('SELECT name, workspace_id FROM person')
  ok('existing people survive the upgrade', people.length === 2, people.map((p) => p.name).join(', '))
  ok('and are adopted by the first workspace',
     people.every((p) => p.workspace_id === workspaceId))

  const tasks = await q<{ title: string; status: string; stage: string }>('SELECT title, status, stage FROM task')
  ok('tasks gain a board stage', tasks.length === 2 && tasks.every((t) => t.stage))
  ok('a finished task lands in the Done column',
     tasks.find((t) => t.status === 'done')?.stage === 'done',
     tasks.map((t) => `${t.title}=${t.stage}`).join(', '))

  const icons = await q<{ icon_path: string }>('SELECT icon_path FROM workspace UNION ALL SELECT icon_path FROM project')
  ok('workspaces and projects gain an icon column', icons.length === 3 && icons.every((i) => i.icon_path === ''))

  const dropped = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE (table_name = 'project'
              AND column_name IN ('current_state', 'next_action', 'open_questions'))
        OR (table_name = 'membership' AND column_name = 'is_escalation')`)
  ok('the retired columns are dropped on upgrade', dropped.length === 0,
     dropped.map((d) => d.column_name).join(', '))

  // Worklanes go, and the items that sat in them stay.
  const laneRelics = await q<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'lane'
      UNION ALL
     SELECT column_name FROM information_schema.columns
      WHERE table_name = 'task' AND column_name = 'lane_id'`)
  ok('worklanes are dropped on upgrade', laneRelics.length === 0, laneRelics.map((r) => r.name).join(', '))
  ok('and their items survive it', tasks.length === 2, tasks.map((t) => t.title).join(', '))

  const colors = await q<{ color: string }>('SELECT color FROM project')
  ok('projects gain a colour column, empty so they inherit the workspace',
     colors.length === 1 && colors[0]?.color === '', JSON.stringify(colors))

  // A meeting stops being a form and becomes a page with real to-do items beside it.
  // Four columns go, and everything written in them has to survive the crossing.
  const meetingCols = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'meeting' AND column_name IN ('agenda', 'location', 'starts_at', 'actions')`)
  ok('the retired meeting columns are dropped on upgrade', meetingCols.length === 0,
     meetingCols.map((c) => c.column_name).join(', '))

  const upgraded = await q<{ title: string; body: string }>('SELECT title, body FROM meeting')
  ok('the meeting itself survives', upgraded.length === 1 && upgraded[0]?.title === 'An old meeting')
  ok('and its agenda and its where are folded into the write-up rather than dropped',
     /_Where: Room 4_/.test(upgraded[0]?.body ?? '') &&
     /## Agenda\nFirst thing\nSecond thing/.test(upgraded[0]?.body ?? '') &&
     /What was said\./.test(upgraded[0]?.body ?? ''),
     JSON.stringify(upgraded[0]?.body))

  const todos = await q<{ text: string; task_id: string | null }>(
    'SELECT text, task_id FROM meeting_todo ORDER BY sort_order')
  ok('every line of the old actions box becomes a to-do item, blank lines aside',
     todos.length === 2 && todos[0]?.text === 'Me: chase the ruling' &&
     todos[1]?.text === 'Priya: error states' && todos.every((t) => t.task_id === null),
     todos.map((t) => t.text).join(' | '))

  const boards = await q<{ name: string; is_done: boolean }>(
    'SELECT name, is_done FROM board_column ORDER BY sort_order'
  )
  ok('an upgraded project gets the default board', boards.length === 4 &&
     boards.map((b) => b.name).join(' > ') === 'To do > In progress > In review > Done',
     boards.map((b) => b.name).join(' > '))
  const placed = await q<{ title: string; column_name: string }>(
    `SELECT t.title, c.name AS column_name FROM task t JOIN board_column c ON c.id = t.column_id`
  )
  ok('old cards land on it', placed.length === 2, placed.map((p) => `${p.title}=${p.column_name}`).join(', '))
  ok('a finished task lands in the done column',
     placed.find((p) => p.title === 'An old finished task')?.column_name === 'Done')

  await ensureMeEverywhere()
  const me = await q<{ name: string; workspace_id: string }>('SELECT name, workspace_id FROM person WHERE is_me')
  ok('you are added to every workspace on upgrade', me.length === 2,
     `${me.length} copies of you`)
  ok('older people are untouched by that',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM person WHERE NOT is_me'))[0]?.n === 2)
  ok('tasks gain an assignee column',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM task WHERE assignee_person_id IS NULL'))[0]?.n === 2)

  // The activity log gained the column that lets a note being written collapse into
  // one line; the lines written before it keep their place and simply have none.
  const oldLines = await q<{ summary: string; entity_id: string | null }>(
    'SELECT summary, entity_id FROM activity'
  )
  ok('the activity log gains an entity column', oldLines.length === 1 && oldLines[0]?.entity_id === null,
     JSON.stringify(oldLines))
  ok('and the lines already in it are untouched', oldLines[0]?.summary === 'Note: an old line')

  const projects = await q<{ name: string }>('SELECT name FROM project')
  ok('the project itself is untouched', projects[0]?.name === 'Legacy project')

  // Running it a second time must be a no-op, not a failure.
  await initDb()
  await ensureMeEverywhere()
  ok('dropping columns leaves every foreign key with its constraint',
     (await orphanedForeignKeys()).length === 0, (await orphanedForeignKeys()).join(', '))

  const reRun = await q<{ body: string }>('SELECT body FROM meeting')
  ok('a second launch neither duplicates the to-do items nor folds the agenda in twice',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM meeting_todo'))[0]?.n === 2 &&
     (reRun[0]?.body.match(/## Agenda/g) ?? []).length === 1,
     JSON.stringify(reRun[0]?.body))

  ok('opening it again is safe',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM person WHERE NOT is_me'))[0]?.n === 2 &&
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM person WHERE is_me'))[0]?.n === 2,
     'repeated launches do not duplicate you')
}

main().catch((e) => {
  console.error('THREW', e)
  process.exitCode = 1
})
