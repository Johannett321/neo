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

-- A link you put on the workspace's own front page: the intranet, the timesheet, the
-- one dashboard you open every morning. Deliberately not the link table, which hangs
-- off a project and carries a kind that decides its icon — these are yours, they
-- belong to no project, and a label is all they say. Nothing derives from them.
CREATE TABLE IF NOT EXISTS workspace_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  label        text NOT NULL,
  url          text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
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

-- A named band of cards on the page you are already on, which folds shut. The other
-- half of grouping and deliberately not a folder: a folder is somewhere you go, a
-- collapsible is somewhere things are. Its folder_id is the level it is drawn at, null
-- at the top; it holds nothing but a name and never reaches the Markdown mirror.
CREATE TABLE IF NOT EXISTS project_collapsible (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  folder_id    uuid REFERENCES project_folder(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  is_collapsed boolean NOT NULL DEFAULT false,
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
  -- Which band on that page it sits in, if any. SET NULL for the same reason folder_id
  -- is: losing the grouping must never be a way to lose the project.
  collapsible_id     uuid REFERENCES project_collapsible(id) ON DELETE SET NULL,
  -- Where the card sits in the grid, once you have said. Zero is the whole of the
  -- default and means "never placed by hand": a project at zero is ordered the way it
  -- always was, by pin and then by what has happened lately, and only the ones you
  -- have actually dragged carry a number. Every hand-set order therefore starts at 1
  -- (see reorder() in ipc/util.ts), which keeps zero free to mean nothing at all.
  sort_order         integer NOT NULL DEFAULT 0,
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

-- Somewhere to file notes, and somewhere to file meetings. The project-scoped twin of
-- project_folder, and filing in exactly the same sense: no dates, no state, no work of
-- its own, and nothing derived reads it. The kind column keeps the two trees apart:
-- one table, because everything about them is identical but the word on the screen.
--
-- Deleting one is handled in the handler, which lifts what is inside it up a level
-- first; the cascade here is only the backstop for a project going away, and it can
-- afford to be one because a note loses its folder rather than its life.
CREATE TABLE IF NOT EXISTS content_folder (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  parent_id  uuid REFERENCES content_folder(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
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

-- The one join table, and the only row in the schema that had no id of its own.
-- It has one now: the operation log addresses every row it carries by a single id,
-- and a composite key would mean a second way of naming a row for one table's sake.
-- The pair stays unique — that is what the table is for — so nothing else changes.
CREATE TABLE IF NOT EXISTS meeting_attendee (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
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

-- That something was said, so that it is not said twice.
--
-- The notifications themselves are derived from deadlines and due dates every time
-- they are asked for and are never written down — there is no reminder here to
-- create, edit or clean up after. This table holds one fact and nothing else: this
-- workspace was told this kind of thing on this day. The unique index below is what
-- makes the whole thing idempotent, and it is why a machine that starts and stops
-- four times before lunch still only interrupts you once.
CREATE TABLE IF NOT EXISTS notification (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  -- The calendar day it was delivered on, as YYYY-MM-DD, for the same reason every
  -- other calendar date in here is text: a day is a day where the user is sitting.
  on_date      text NOT NULL,
  -- Kept because it costs nothing and makes "what did it actually say" answerable.
  title        text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
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


-- Every write in the application, as it happened.
--
-- Deliberately without a foreign key to workspace: the log outlives the rows it
-- describes, exactly as activity.entity_id does. A batch that deleted a workspace
-- must still be readable afterwards, or the deletion could never be sent anywhere.
--
-- seq is a local cursor and nothing more — it says what this machine has yet to
-- hand to a transport. The *ordering* of the data is the hlc, which is the same on
-- every device; the sequence number is only ever "what have I not sent".
CREATE TABLE IF NOT EXISTS op_batch (
  seq            bigserial PRIMARY KEY,
  id             uuid NOT NULL UNIQUE,
  workspace_id   uuid,
  device_id      text NOT NULL,
  actor_id       uuid,
  schema_version integer NOT NULL,
  hlc            text NOT NULL,
  -- local | remote. A remote batch is recorded so that replay reproduces state and
  -- so a third device can be fed from this one, but it is never sent back.
  origin         text NOT NULL DEFAULT 'local',
  ops            jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-row sync metadata, kept beside the domain tables rather than inside them.
--
-- One table instead of a jsonb column on all twenty-five: nothing in the schema
-- above changes shape, pick()'s allowlists keep meaning exactly what they meant,
-- and a row's stamps disappear with it. It holds two things:
--
--   field_hlc   when each column was last written, so last-write-wins is decided per
--               field rather than per row — two devices editing a project's name and
--               its deadline in the same minute must not cost one of them.
--   deleted_hlc the tombstone. A cascade is deterministic, so only the parent delete
--               travels; this is what stops a task created on the phone from
--               resurrecting a project a Mac deleted while the phone was offline.
CREATE TABLE IF NOT EXISTS sync_row (
  table_name  text NOT NULL,
  row_id      text NOT NULL,
  field_hlc   jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_hlc text,
  PRIMARY KEY (table_name, row_id)
);

-- How far this device has read each workspace's stream on the server.
--
-- Only the *pull* cursor lives here, one row per workspace, because a stream that
-- cannot be reached must not hold up the others. What has been pushed is a single
-- number in setting: batches leave in the order they were written, so one that
-- fails stops the queue behind it on purpose.
--
-- No foreign key to workspace: a device that has signed in and not yet replayed
-- anything has a cursor for a workspace whose rows have not arrived.
CREATE TABLE IF NOT EXISTS sync_state (
  workspace_id uuid PRIMARY KEY,
  remote_seq   bigint NOT NULL DEFAULT 0,
  synced_at    timestamptz
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
CREATE INDEX IF NOT EXISTS idx_workspace_link    ON workspace_link (workspace_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_journal_project    ON journal_entry (project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project   ON activity (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_ws    ON conversation (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_message_conv  ON chat_message (conversation_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_chat_attach_conv   ON chat_attachment (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_meeting ON recording (meeting_id);
CREATE INDEX IF NOT EXISTS idx_recording_segment ON recording_segment (recording_id, ord);
CREATE INDEX IF NOT EXISTS idx_transcript_cue    ON transcript_cue (recording_id, ord);
CREATE INDEX IF NOT EXISTS idx_summary_part      ON summary_part (recording_id, ord);
CREATE INDEX IF NOT EXISTS idx_op_batch_pending  ON op_batch (origin, seq);
CREATE INDEX IF NOT EXISTS idx_op_batch_ws       ON op_batch (workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_sync_row_dead     ON sync_row (table_name, row_id) WHERE deleted_hlc IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendee_id ON meeting_attendee (id);

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
  `ALTER TABLE meeting_attendee ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid()`,
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
  // The Today page's own furniture. A workspace is a working life, and its front page
  // is allowed to look like one: a photograph across the top, a line about what you do
  // here, a place to read the weather for. None of it is derived from anything and
  // nothing derives from it — it is the one part of the app that is decoration, which
  // is exactly why it is safe to let the user own it.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS banner_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT ''`,
  // Which part of the banner you actually see. A photograph is rarely five times as
  // wide as it is tall, so `object-fit: cover` throws most of one away; these two are
  // the `object-position` that decides which part goes. Percentages, because the strip
  // is a different width on every window, and 50/50 — dead centre — is what a picture
  // that has never been dragged should show.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS banner_x integer NOT NULL DEFAULT 50`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS banner_y integer NOT NULL DEFAULT 50`,
  // Where the weather is read for. Empty means "work it out from the machine's own
  // timezone", which is what makes it work before anybody has configured anything.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS weather_place text NOT NULL DEFAULT ''`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS weather_latitude double precision`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS weather_longitude double precision`,
  // Degrees are about the person, not about the working life — nobody wants Celsius
  // in the day job and Fahrenheit in their own company — so the unit lives in app
  // settings beside the clock and the date format, and the column goes.
  `ALTER TABLE workspace DROP COLUMN IF EXISTS weather_units`,
  // What the page is allowed to show. Discrete columns rather than one JSON blob, so
  // `pick()`'s allowlist still means something and a typo cannot invent a preference.
  // There is no toggle for overdue or due today: those two are what the screen is for,
  // and a Today page you can switch the work off is a wallpaper.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_clock boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_weather boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_bio boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_links boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_stats boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_attention boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_meeting_todos boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS today_show_soon boolean NOT NULL DEFAULT true`,
  // What this working life is allowed to say out loud, and when. Discrete columns
  // again rather than a blob, for the reason above. The two "how many days before"
  // are numbers with zero meaning never, rather than a switch and a number that
  // could disagree with each other; an upgraded database therefore arrives with the
  // same defaults a new one gets, and the machine's own master switch above it is
  // what decides whether any of it is heard.
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify_project_ahead_days integer NOT NULL DEFAULT 7`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify_project_on_the_day boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify_task_ahead_days integer NOT NULL DEFAULT 1`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify_task_on_the_day boolean NOT NULL DEFAULT true`,
  `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS notify_task_day_after boolean NOT NULL DEFAULT true`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS suggested_title text NOT NULL DEFAULT ''`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS recap_written_at timestamptz`,
  `ALTER TABLE recording ADD COLUMN IF NOT EXISTS recap_todos_at timestamptz`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS icon_path text NOT NULL DEFAULT ''`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS deadline text`,
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT ''`,
  // Filing, added later than the projects it files. SET NULL rather than CASCADE:
  // losing a folder must never be a way to lose a project.
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES project_folder(id) ON DELETE SET NULL`,
  // Arranging the cards by hand, added long after the grid. It needs no backfill and
  // deliberately has none: zero means "never placed", every project already has it,
  // and a database that has just been upgraded therefore draws in exactly the order it
  // drew in before — until the first card is dragged.
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0`,
  // Grouping in place, added after the folders it sits beside. The table itself is in
  // the DDL above and therefore already exists by the time this runs.
  `ALTER TABLE project ADD COLUMN IF NOT EXISTS collapsible_id uuid REFERENCES project_collapsible(id) ON DELETE SET NULL`,
  // The where-we-are block is gone: a snapshot you have to keep rewriting by hand is
  // a status field wearing a different hat, and the log already keeps the history.
  // Dropping the columns is deliberate and irreversible — the text in them goes.
  `ALTER TABLE project DROP COLUMN IF EXISTS current_state`,
  `ALTER TABLE project DROP COLUMN IF EXISTS next_action`,
  `ALTER TABLE project DROP COLUMN IF EXISTS open_questions`,
  // "Escalation path" was one more thing to mark by hand, on every person on every
  // project, and it never earned it — who to push on is what the role already says.
  `ALTER TABLE membership DROP COLUMN IF EXISTS is_escalation`,
  // Filing notes and meetings, added long after both. SET NULL rather than CASCADE, for
  // the reason a project's folder is: losing the filing must never be a way to lose the
  // writing. The table itself is in the DDL above and therefore already exists here.
  `ALTER TABLE note ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES content_folder(id) ON DELETE SET NULL`,
  `ALTER TABLE meeting ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES content_folder(id) ON DELETE SET NULL`,
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
  `CREATE INDEX IF NOT EXISTS idx_project_order ON project (workspace_id, folder_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS idx_folder_parent ON project_folder (workspace_id, parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_collapsible ON project (collapsible_id)`,
  `CREATE INDEX IF NOT EXISTS idx_collapsible_level ON project_collapsible (workspace_id, folder_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS idx_note_folder ON note (folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_folder ON meeting (folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_content_folder_level ON content_folder (project_id, kind, parent_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS idx_task_stage ON task (project_id, stage)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_person_me ON person (workspace_id) WHERE is_me`,
  // Said once, and once only. Not merely a lookup: the insert that claims a day is
  // what decides whether the notification is shown at all, so this index is the
  // guard itself rather than an optimisation over one.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_once ON notification (workspace_id, kind, on_date)`
]
