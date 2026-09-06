import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { __dataDir } from 'electron'
import { initDb, orphanedForeignKeys, q } from '../src/main/db/client'
import { mapWorkspace } from '../src/main/db/map'
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

  // Arranging the cards by hand arrived long after the grid, and deliberately without a
  // backfill: zero is "never placed", so an upgraded database draws in exactly the
  // order it drew in before anyone had the option.
  const places = await q<{ sort_order: number }>('SELECT sort_order FROM project')
  ok('projects gain a place in the grid, unset so nothing about the order changes',
     places.length === 1 && places[0]?.sort_order === 0, JSON.stringify(places))

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

  // The assistant arrived long after this database was written. Its tables have to
  // appear, its two columns have to land on a workspace table that predates them,
  // and a workspace that has never seen a key must read as having none rather than
  // as having an empty one that something later mistakes for a value.
  const keys = await q<{ ai_api_key: string; ai_model: string }>(
    'SELECT ai_api_key, ai_model FROM workspace ORDER BY name'
  )
  ok('an old workspace gains the assistant columns, empty',
     keys.length === 2 && keys.every((w) => w.ai_api_key === '' && w.ai_model === ''))
  ok('and maps to a workspace the renderer is told has no key',
     (await q<any>('SELECT * FROM workspace ORDER BY name')).every((row) => mapWorkspace(row).aiKeySet === false))

  const chatTables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('conversation', 'chat_message', 'chat_attachment')
     ORDER BY table_name`
  )
  ok('the assistant\'s tables are created on an old database',
     chatTables.length === 3, chatTables.map((t) => t.table_name).join(', '))

  // A conversation is only meaningful inside its workspace, and must go when it does.
  const [workspaceRow] = await q<{ id: string }>('SELECT id FROM workspace ORDER BY name LIMIT 1')
  const [madeChat] = await q<{ id: string }>(
    'INSERT INTO conversation (workspace_id, title) VALUES ($1, $2) RETURNING id',
    [workspaceRow.id, 'Upgraded chat']
  )
  ok('a conversation can be written on an upgraded database', Boolean(madeChat?.id))

  // Recording arrived long after these rows did, so every table and every column it
  // needs has to appear on a database that predates the whole idea of it.
  const recordingTables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('recording', 'recording_segment', 'transcript_cue', 'summary_part')
     ORDER BY table_name`
  )
  ok('the recording tables are created on an old database',
     recordingTables.length === 4, recordingTables.map((t) => t.table_name).join(', '))

  const recordingSettings = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'workspace' AND column_name LIKE ANY (ARRAY['transcribe%', 'recap%'])
     ORDER BY column_name`
  )
  ok('and every workspace gains the settings that say how it transcribes and recaps',
     recordingSettings.length === 8, recordingSettings.map((c) => c.column_name).join(', '))

  // The whole feature turns on being able to write these rows, so writing one is the
  // assertion rather than the shape of the table being right on paper.
  const [oldMeeting] = await q<{ id: string }>('SELECT id FROM meeting LIMIT 1')
  const [madeRecording] = await q<{ id: string }>(
    'INSERT INTO recording (meeting_id) VALUES ($1) RETURNING id',
    [oldMeeting.id]
  )
  const [madeSegment] = await q<{ id: string }>(
    `INSERT INTO recording_segment (recording_id, ord, path) VALUES ($1, 0, '0000.webm') RETURNING id`,
    [madeRecording.id]
  )
  await q(
    `INSERT INTO transcript_cue (recording_id, segment_id, ord, start_ms, end_ms, text)
     VALUES ($1, $2, 0, 0, 1000, 'hello')`,
    [madeRecording.id, madeSegment.id]
  )
  ok('a recording, its segments and its transcript can be written on an upgraded database',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM transcript_cue'))[0]?.n === 1)

  // The columns that decide whether a recap has already been folded into its meeting.
  // Without them every launch would append the same recap to the same write-up again.
  const foldColumns = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'recording'
       AND column_name IN ('suggested_title', 'recap_written_at', 'recap_todos_at')
     ORDER BY column_name`
  )
  ok('a recording gains the columns that stop a recap being folded in twice',
     foldColumns.length === 3, foldColumns.map((c) => c.column_name).join(', '))

  // One recording per meeting, enforced by the index rather than by the handler.
  let secondRefused = false
  try {
    await q('INSERT INTO recording (meeting_id) VALUES ($1)', [oldMeeting.id])
  } catch {
    secondRefused = true
  }
  ok('a meeting cannot end up with two recordings', secondRefused)

  /*
   * Folders arrived long after these projects did. The table is created by the DDL
   * and the column that points at it by a migration, in that order — the column
   * cannot be added before the table it references exists, which is the whole reason
   * the migrations run in labelled groups.
   */
  const [oldProject] = await q<{ id: string; workspace_id: string }>(
    'SELECT id, workspace_id FROM project ORDER BY name LIMIT 1'
  )
  const [madeFolder] = await q<{ id: string }>(
    `INSERT INTO project_folder (workspace_id, name) VALUES ($1, 'Clients') RETURNING id`,
    [oldProject.workspace_id]
  )
  await q('UPDATE project SET folder_id = $2 WHERE id = $1', [oldProject.id, madeFolder.id])
  ok('a project that predates folders can be filed in one',
     (await q<{ folder_id: string }>('SELECT folder_id FROM project WHERE id = $1', [oldProject.id]))[0]
       ?.folder_id === madeFolder.id)

  // Deleting the folder must free the project rather than take it down with it.
  await q('DELETE FROM project_folder WHERE id = $1', [madeFolder.id])
  ok('and losing the folder unfiles the project instead of deleting it',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM project WHERE id = $1', [oldProject.id]))[0]?.n === 1 &&
     (await q<{ folder_id: string | null }>('SELECT folder_id FROM project WHERE id = $1', [oldProject.id]))[0]
       ?.folder_id === null)

  /*
   * Collapsibles arrived after folders did, and land the same way round: the table in
   * the DDL, the column that points at it in a migration below every ALTER it needs.
   */
  const [madeBand] = await q<{ id: string }>(
    `INSERT INTO project_collapsible (workspace_id, name) VALUES ($1, 'Later') RETURNING id`,
    [oldProject.workspace_id]
  )
  await q('UPDATE project SET collapsible_id = $2 WHERE id = $1', [oldProject.id, madeBand.id])
  ok('a project that predates collapsibles can be put in one',
     (await q<{ collapsible_id: string }>(
       'SELECT collapsible_id FROM project WHERE id = $1', [oldProject.id]
     ))[0]?.collapsible_id === madeBand.id)

  // And losing the band must cost the grouping, never the project.
  await q('DELETE FROM project_collapsible WHERE id = $1', [madeBand.id])
  ok('and losing the collapsible ungroups the project instead of deleting it',
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM project WHERE id = $1', [oldProject.id]))[0]?.n === 1 &&
     (await q<{ collapsible_id: string | null }>(
       'SELECT collapsible_id FROM project WHERE id = $1', [oldProject.id]
     ))[0]?.collapsible_id === null)

  /*
   * The Today page's furniture arrived last of all. An upgraded database has never
   * seen any of it, so what matters is that it comes back *on*: a workspace that has
   * been used for a year should gain the block, not a blank where the counts were.
   */
  const [furnished] = await q<{
    banner_path: string
    bio: string
    banner_x: number
    today_show_clock: boolean
    today_show_meeting_todos: boolean
  }>(
    `SELECT banner_path, bio, banner_x, today_show_clock, today_show_meeting_todos
     FROM workspace ORDER BY name LIMIT 1`
  )
  ok('an old workspace gains the Today page settings, showing everything it used to',
     furnished?.banner_path === '' && furnished?.bio === '' &&
     furnished?.banner_x === 50 &&
     furnished?.today_show_clock === true && furnished?.today_show_meeting_todos === true)

  // The table is in the DDL and the workspace it hangs off predates it by a year.
  const [oldLink] = await q<{ id: string }>(
    `INSERT INTO workspace_link (workspace_id, label, url)
     VALUES ($1, 'Intranet', 'https://intranet.example.com') RETURNING id`,
    [oldProject.workspace_id]
  )
  ok('a workspace that predates the front page can be given links on it',
     Boolean(oldLink?.id) &&
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM workspace_link'))[0]?.n === 1)

  const [told] = await q<{
    notify: boolean
    notify_project_ahead_days: number
    notify_task_ahead_days: number
    notify_task_day_after: boolean
  }>(
    `SELECT notify, notify_project_ahead_days, notify_task_ahead_days, notify_task_day_after
     FROM workspace ORDER BY name LIMIT 1`
  )
  ok('an old workspace arrives with the same notification settings a new one gets',
     told?.notify === true && told?.notify_project_ahead_days === 7 &&
     told?.notify_task_ahead_days === 1 && told?.notify_task_day_after === true)

  // The table is in the DDL, its workspace predates it, and the unique index on it is
  // the whole of the once-a-day guarantee rather than an optimisation over one.
  await q(
    `INSERT INTO notification (workspace_id, kind, on_date, title)
     VALUES ($1, 'task-day', '2026-01-05', 'Something is due today')`,
    [oldProject.workspace_id]
  )
  const twice = await q<{ id: string }>(
    `INSERT INTO notification (workspace_id, kind, on_date, title)
     VALUES ($1, 'task-day', '2026-01-05', 'Said again')
     ON CONFLICT (workspace_id, kind, on_date) DO NOTHING RETURNING id`,
    [oldProject.workspace_id]
  )
  ok('and the same thing cannot be said to it twice on one day',
     twice.length === 0 &&
     (await q<{ n: number }>('SELECT count(*)::int AS n FROM notification'))[0]?.n === 1)

  // An old workspace read back through the mapper has to draw, banner and all.
  const [mappedRow] = await q<Record<string, unknown>>('SELECT * FROM workspace ORDER BY name LIMIT 1')
  ok('and an upgraded workspace maps to one the Today page can draw',
     mapWorkspace(mappedRow).banner === null && mapWorkspace(mappedRow).todayShowWeather === true)

  // An existing database has workspaces but no onboarding marker, which is exactly
  // the pair the renderer reads: it is the *absence of any workspace, ever* that says
  // this is a new install, so an upgrade lands in the app rather than in the pitch.
  const marker = await q<{ value: string }>('SELECT value FROM setting WHERE key = $1', ['onboardedAt'])
  const workspaceCount = await q<{ n: number }>('SELECT count(*)::int AS n FROM workspace')
  ok('an upgraded database has no onboarding marker, and workspaces that make one unnecessary',
     marker.length === 0 && workspaceCount[0]?.n === 2)

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
