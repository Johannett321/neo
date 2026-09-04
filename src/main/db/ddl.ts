/**
 * The schema, applied idempotently on every launch.
 *
 * Calendar dates (due dates, decision dates) are stored as `text` in YYYY-MM-DD
 * rather than `date`. A desktop app renders dates in local time, and round-tripping
 * a `date` column through a driver that hands back a UTC-midnight Date object is
 * how you end up showing "due yesterday". Text sorts and compares correctly and
 * never shifts. Timestamps, where the instant genuinely matters, stay timestamptz.
 */
export const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS workspace (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  color        text NOT NULL DEFAULT '#6366f1',
  icon_path    text NOT NULL DEFAULT '',
  sort_order   integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name               text NOT NULL,
  summary            text NOT NULL DEFAULT '',
  icon_path          text NOT NULL DEFAULT '',
  color              text NOT NULL DEFAULT '',
  deadline           text,
  status             text NOT NULL DEFAULT 'active',
  is_pinned          boolean NOT NULL DEFAULT false,
  last_opened_at     timestamptz,
  previous_opened_at timestamptz,
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);

CREATE TABLE IF NOT EXISTS board_column (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  -- The column that means finished. Dropping a card here ticks it, and ticking a task
  -- anywhere else moves its card here.
  is_done     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name             text NOT NULL,
  org              text NOT NULL DEFAULT '',
  email            text NOT NULL DEFAULT '',
  phone            text NOT NULL DEFAULT '',
  timezone         text NOT NULL DEFAULT '',
  avatar_color     text NOT NULL DEFAULT '#64748b',
  avatar_path      text NOT NULL DEFAULT '',
  is_me            boolean NOT NULL DEFAULT false,
  how_to_work_with text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS membership (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, project_id)
);

CREATE TABLE IF NOT EXISTS task (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title                text NOT NULL,
  details              text NOT NULL DEFAULT '',
  kind                 text NOT NULL DEFAULT 'task',
  status               text NOT NULL DEFAULT 'open',
  stage                text NOT NULL DEFAULT 'todo',
  due_date             text,
  column_id            uuid REFERENCES board_column(id) ON DELETE SET NULL,
  assignee_person_id   uuid REFERENCES person(id) ON DELETE SET NULL,
  completed_at         timestamptz,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT '',
  body       text NOT NULL DEFAULT '',
  is_pinned  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  occurred_on text NOT NULL,
  starts_at   text NOT NULL DEFAULT '',
  location    text NOT NULL DEFAULT '',
  agenda      text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  actions     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_attendee (
  meeting_id uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id)
);

CREATE TABLE IF NOT EXISTS decision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title        text NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  alternatives text NOT NULL DEFAULT '',
  decided_by   text NOT NULL DEFAULT '',
  decided_on   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label      text NOT NULL,
  url        text NOT NULL,
  kind       text NOT NULL DEFAULT 'other',
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  occurred_on text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  summary    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setting (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_workspace  ON project (workspace_id);
CREATE INDEX IF NOT EXISTS idx_column_project     ON board_column (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_task_project       ON task (project_id);
CREATE INDEX IF NOT EXISTS idx_task_due           ON task (due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_membership_project ON membership (project_id);
CREATE INDEX IF NOT EXISTS idx_membership_person  ON membership (person_id);
CREATE INDEX IF NOT EXISTS idx_note_project       ON note (project_id);
CREATE INDEX IF NOT EXISTS idx_decision_project   ON decision (project_id);
CREATE INDEX IF NOT EXISTS idx_meeting_project    ON meeting (project_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_link_project       ON link (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_journal_project    ON journal_entry (project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project   ON activity (project_id, created_at DESC);

`


/**
 * Applied one statement at a time, in order, on every launch.
 *
 * They cannot live in the DDL string above: PostgreSQL parses every statement in a
 * multi-statement batch before executing any of them, so a statement that references
 * a column an earlier ALTER is about to add fails to parse. Each of these therefore
 * gets its own round trip, and every one is written to be safe to run repeatedly.
 */
export const MIGRATIONS: string[] = [
  // 1. Columns first. Nothing below may reference a column added further down.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS icon_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS icon_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS deadline text`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT ''`,
  // The where-we-are block is gone: a snapshot you have to keep rewriting by hand is
  // a status field wearing a different hat, and the log already keeps the history.
  // Dropping the columns is deliberate and irreversible — the text in them goes.
  `ALTER TABLE project DROP COLUMN IF EXISTS current_state`,
  `ALTER TABLE project DROP COLUMN IF EXISTS next_action`,
  `ALTER TABLE project DROP COLUMN IF EXISTS open_questions`,
  // "Escalation path" was one more thing to mark by hand, on every person on every
  // project, and it never earned it — who to push on is what the role already says.
  `ALTER TABLE membership DROP COLUMN IF EXISTS is_escalation`,
  `ALTER TABLE person ADD COLUMN IF NOT EXISTS avatar_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE person ADD COLUMN IF NOT EXISTS is_me boolean NOT NULL DEFAULT false`,
  `ALTER TABLE person ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE`,
  `ALTER TABLE task ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'todo'`,
  `ALTER TABLE task ADD COLUMN IF NOT EXISTS assignee_person_id uuid REFERENCES person(id) ON DELETE SET NULL`,
  `ALTER TABLE task ADD COLUMN IF NOT EXISTS column_id uuid REFERENCES board_column(id) ON DELETE SET NULL`,
  // Worklanes are gone. A second axis to file work along was one more thing to keep
  // tidy by hand, and the board's columns already say where a card is. The tasks stay;
  // only the lane they sat in goes. The column must be dropped before the table it
  // references, and both are irreversible.
  `ALTER TABLE task DROP COLUMN IF EXISTS lane_id`,
  `DROP TABLE IF EXISTS lane`,

  // 2. Constraint changes. Guarded, because a database created after the change
  //    never had the column in the first place.
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'project' AND column_name = 'my_role') THEN
       ALTER TABLE project ALTER COLUMN my_role DROP NOT NULL;
     END IF;
   END $$`,

  // 3. Backfills, now that every column they mention exists.
  // Boards used to have four fixed stages; they are now rows, so give every project
  // the default set and move its cards onto them.
  `INSERT INTO board_column (project_id, name, sort_order, is_done)
   SELECT p.id, v.name, v.ord, v.done
   FROM project p
   CROSS JOIN (VALUES ('To do', 0, false), ('In progress', 1, false),
                      ('In review', 2, false), ('Done', 3, true)) AS v(name, ord, done)
   WHERE NOT EXISTS (SELECT 1 FROM board_column c WHERE c.project_id = p.id)`,
  `UPDATE task t SET column_id = c.id
   FROM board_column c
   WHERE c.project_id = t.project_id
     AND t.column_id IS NULL
     AND c.name = CASE
       WHEN t.status = 'done' THEN 'Done'
       WHEN t.stage = 'doing' THEN 'In progress'
       ELSE 'To do'
     END`,
  `UPDATE task SET stage = 'done' WHERE status = 'done' AND stage <> 'done'`,
  // People predate workspaces, so put them in the first one rather than dropping them.
  `UPDATE person SET workspace_id = (SELECT id FROM workspace ORDER BY sort_order, name LIMIT 1)
   WHERE workspace_id IS NULL`,

  // 4. Indexes last, since they are the most likely to reference a migrated column.
  `CREATE INDEX IF NOT EXISTS idx_person_workspace ON person (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_stage ON task (project_id, stage)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_person_me ON person (workspace_id) WHERE is_me`
]
