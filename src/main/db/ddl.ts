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

-- Somewhere to file projects, and nothing more: no dates, no state, no work of its
-- own. Deleting one is handled in the handler, which lifts everything inside it up a
-- level first; the cascade here is only the backstop for a workspace going away, and
-- it can afford to be one because a project loses its folder rather than its life.
CREATE TABLE IF NOT EXISTS project_folder (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES project_folder(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
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
  folder_id          uuid REFERENCES project_folder(id) ON DELETE SET NULL,
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
  body        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_attendee (
  meeting_id uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, person_id)
);

CREATE TABLE IF NOT EXISTS meeting_todo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  text       text NOT NULL DEFAULT '',
  done       boolean NOT NULL DEFAULT false,
  -- Set once the item has been put on the board. From then on the card decides
  -- whether it is finished, so the done column above stops being read. And
  -- ON DELETE SET NULL rather than CASCADE:
  -- deleting the card returns the item to the meeting rather than taking it too.
  task_id    uuid REFERENCES task(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
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
  -- What the line is about, when the thing it is about is edited repeatedly. Not a
  -- foreign key on purpose: the log outlives the row it describes. See logActivity().
  entity_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setting (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- A chat with the assistant. Scoped to a workspace like everything else, so the
-- assistant opened inside a client's area cannot answer out of the day job's.
CREATE TABLE IF NOT EXISTS conversation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One API turn. The blocks column is the message content exactly as the API sends
-- and receives it — text, function calls, function output — so reopening a
-- conversation replays it to the model unchanged rather than reconstructing it from
-- a rendered copy. The tools column is the display record beside it: what each call
-- did, and whether it was allowed to. Keeping the two apart is what stops the replay
-- carrying fields the API would reject.
CREATE TABLE IF NOT EXISTS chat_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role            text NOT NULL,
  blocks          jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools           jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Files dropped into a conversation. The bytes live in attachments/ beside the
-- icons, so a backup of the folder is still a backup of everything.
CREATE TABLE IF NOT EXISTS chat_attachment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES chat_message(id) ON DELETE CASCADE,
  name            text NOT NULL DEFAULT '',
  mime            text NOT NULL DEFAULT '',
  bytes           integer NOT NULL DEFAULT 0,
  path            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Recording a meeting.
--
-- One row per recorded meeting, and it is a state machine rather than a file: three
-- steps (words, speakers, recap) each with their own state, error and attempt count,
-- so an interruption in any of them is resumed at the step it reached rather than
-- from the beginning. Nothing here is derived from a process being alive — a machine
-- that loses power leaves these rows exactly as they were, and the pipeline reads
-- them on the next launch and carries on.
CREATE TABLE IF NOT EXISTS recording (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,

  -- recording | interrupted | stopped
  capture_state       text NOT NULL DEFAULT 'recording',
  started_at          timestamptz NOT NULL DEFAULT now(),
  stopped_at          timestamptz,
  -- Bumped by the renderer that holds the microphone. Gone quiet means gone.
  heartbeat_at        timestamptz NOT NULL DEFAULT now(),
  duration_ms         bigint NOT NULL DEFAULT 0,
  bytes               bigint NOT NULL DEFAULT 0,
  -- Set when the audio is thrown away and the words are kept.
  audio_deleted_at    timestamptz,
  mime                text NOT NULL DEFAULT 'audio/webm',

  transcript_state    text NOT NULL DEFAULT 'pending',
  transcript_error    text NOT NULL DEFAULT '',
  transcript_attempts integer NOT NULL DEFAULT 0,
  transcript_engine   text NOT NULL DEFAULT '',
  transcript_model    text NOT NULL DEFAULT '',
  transcribed_at      timestamptz,

  speaker_state       text NOT NULL DEFAULT 'pending',
  speaker_error       text NOT NULL DEFAULT '',
  speaker_attempts    integer NOT NULL DEFAULT 0,
  -- label -> { name, personId }. Renaming a speaker is one row, not a rewrite of
  -- every line they said.
  speakers            jsonb NOT NULL DEFAULT '{}'::jsonb,

  summary_state       text NOT NULL DEFAULT 'pending',
  summary_error       text NOT NULL DEFAULT '',
  summary_attempts    integer NOT NULL DEFAULT 0,
  summary_engine      text NOT NULL DEFAULT '',
  summary_model       text NOT NULL DEFAULT '',
  summary             text NOT NULL DEFAULT '',
  recap               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the meeting would be called, if it is still called nothing. Only ever used
  -- to name an untitled meeting; a name you typed is never overwritten.
  suggested_title     text NOT NULL DEFAULT '',
  summarised_at       timestamptz,
  -- When the recap was appended to the write-up. Once, and only once: after that the
  -- write-up is a document you edit, and nothing rewrites it.
  recap_written_at    timestamptz,
  -- And, separately, when its commitments became the meeting's to-do items. Two
  -- markers rather than one because they can fail apart: if creating the to-dos went
  -- wrong, retrying must not append the recap to the write-up a second time.
  recap_todos_at      timestamptz,

  -- The runner will not look at this row again before this instant. Backoff lives in
  -- the database rather than in a timer, so a restart does not lose it.
  next_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One file of audio, five minutes of it, and the unit everything else is resumed by.
CREATE TABLE IF NOT EXISTS recording_segment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
  ord          integer NOT NULL,
  -- Filename inside recordings/<recording id>/. Emptied when the audio is deleted.
  path         text NOT NULL DEFAULT '',
  bytes        bigint NOT NULL DEFAULT 0,
  duration_ms  bigint NOT NULL DEFAULT 0,
  -- Where this segment starts on the recording's own clock.
  offset_ms    bigint NOT NULL DEFAULT 0,
  -- False while it is still being written to. A segment that is still open when the
  -- machine dies is the only audio at risk, and it is at most five minutes of it.
  closed       boolean NOT NULL DEFAULT false,
  state        text NOT NULL DEFAULT 'pending',
  error        text NOT NULL DEFAULT '',
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, ord)
);

-- One phrase, timed against the whole recording rather than against its own segment,
-- so the transcript can follow the playhead across a segment boundary without
-- knowing there is one.
CREATE TABLE IF NOT EXISTS transcript_cue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
  segment_id   uuid REFERENCES recording_segment(id) ON DELETE CASCADE,
  ord          integer NOT NULL,
  start_ms     bigint NOT NULL DEFAULT 0,
  end_ms       bigint NOT NULL DEFAULT 0,
  speaker      text NOT NULL DEFAULT '',
  text         text NOT NULL DEFAULT ''
);

-- A long meeting is summarised in passes: notes over a slice of transcript, then one
-- pass over the notes. The slices are rows so that a summary interrupted two thirds
-- of the way through resumes at the slice it reached.
CREATE TABLE IF NOT EXISTS summary_part (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
  ord          integer NOT NULL,
  from_cue     integer NOT NULL DEFAULT 0,
  to_cue       integer NOT NULL DEFAULT 0,
  state        text NOT NULL DEFAULT 'pending',
  notes        text NOT NULL DEFAULT '',
  error        text NOT NULL DEFAULT '',
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, ord)
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
CREATE INDEX IF NOT EXISTS idx_meeting_todo       ON meeting_todo (meeting_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_link_project       ON link (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_journal_project    ON journal_entry (project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project   ON activity (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_ws    ON conversation (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_message_conv  ON chat_message (conversation_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_chat_attach_conv   ON chat_attachment (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_meeting ON recording (meeting_id);
CREATE INDEX IF NOT EXISTS idx_recording_segment ON recording_segment (recording_id, ord);
CREATE INDEX IF NOT EXISTS idx_transcript_cue    ON transcript_cue (recording_id, ord);
CREATE INDEX IF NOT EXISTS idx_summary_part      ON summary_part (recording_id, ord);

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
  // The assistant's key is per workspace, because the workspace is the boundary it
  // works inside. It is written through its own channel and never read back out.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS ai_api_key text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS ai_model text NOT NULL DEFAULT ''`,
  // How this workspace turns a recording into words and then into a recap. Beside
  // the key rather than in app settings, because "may this leave the machine" is a
  // question you answer once per working life, not once per meeting.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS transcribe_engine text NOT NULL DEFAULT 'openai'`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS transcribe_model text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS transcribe_base_url text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS transcribe_language text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS recap_engine text NOT NULL DEFAULT 'openai'`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS recap_model text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS recap_base_url text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS recap_prompt text NOT NULL DEFAULT ''`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS suggested_title text NOT NULL DEFAULT ''`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS recap_written_at timestamptz`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS recap_todos_at timestamptz`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS icon_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS deadline text`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT ''`,
  // Filing, added later than the projects it files. SET NULL rather than CASCADE:
  // losing a folder must never be a way to lose a project.
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES project_folder(id) ON DELETE SET NULL`,
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
  `ALTER TABLE activity ADD COLUMN IF NOT EXISTS entity_id uuid`,
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

  /*
   * A meeting used to be a form: an agenda box, a where, a time, and a slab of text
   * called "actions". It is now a page of Markdown with real to-do items beside it.
   *
   * The four columns go, and everything written in them is carried across first —
   * each line of `actions` becomes a to-do item, and the agenda and the where are
   * folded into the top of the note, which is the only place left that holds prose.
   * The order matters: the DROPs at the end of this group must come after the
   * statements that read them. Each is wrapped in a guard that checks the column is
   * still there, and the SQL inside is EXECUTEd so that PostgreSQL does not try to
   * parse a reference to a column this migration has already dropped on a past run.
   */
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'meeting' AND column_name = 'actions') THEN
       EXECUTE $q$
         INSERT INTO meeting_todo (meeting_id, text, sort_order)
         SELECT m.id, btrim(regexp_replace(line, '^\\s*[-*]\\s+', '')), ord - 1
         FROM meeting m,
              LATERAL unnest(string_to_array(m.actions, E'\\n')) WITH ORDINALITY AS l(line, ord)
         WHERE btrim(line) <> ''
           AND NOT EXISTS (SELECT 1 FROM meeting_todo t WHERE t.meeting_id = m.id)
       $q$;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'meeting' AND column_name = 'agenda') THEN
       EXECUTE $q$
         UPDATE meeting
            SET body = '## Agenda' || E'\\n' || agenda ||
                       CASE WHEN btrim(body) = '' THEN '' ELSE E'\\n\\n' || body END
          WHERE btrim(agenda) <> ''
       $q$;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'meeting' AND column_name = 'location') THEN
       EXECUTE $q$
         UPDATE meeting
            SET body = '_Where: ' || location || '_' ||
                       CASE WHEN btrim(body) = '' THEN '' ELSE E'\\n\\n' || body END
          WHERE btrim(location) <> ''
       $q$;
     END IF;
   END $$`,
  `ALTER TABLE meeting DROP COLUMN IF EXISTS actions`,
  `ALTER TABLE meeting DROP COLUMN IF EXISTS agenda`,
  `ALTER TABLE meeting DROP COLUMN IF EXISTS location`,
  `ALTER TABLE meeting DROP COLUMN IF EXISTS starts_at`,

  // 4. Indexes last, since they are the most likely to reference a migrated column.
  `CREATE INDEX IF NOT EXISTS idx_person_workspace ON person (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_folder ON project (folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_folder_parent ON project_folder (workspace_id, parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_stage ON task (project_id, stage)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_person_me ON person (workspace_id) WHERE is_me`
]
