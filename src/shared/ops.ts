/**
 * The operation log's contract, the way `api.ts` is IPC's and `mcp.ts` is the socket's.
 *
 * Every write in the application becomes one or more `Op`s inside a `Batch`, and
 * `apply()` is the only thing that touches a domain table. That equivalence is the
 * whole correctness argument for syncing: a batch that arrives over a transport
 * travels the identical path as a click, so there is no second set of writes beside
 * the real ones that can drift — the same reason the assistant's tools are the app's
 * own channels rather than their own SQL.
 *
 * Nothing here imports from main or the renderer. The phone will replay these same
 * batches without a Postgres anywhere near it.
 */

/**
 * The schema the ops in a batch were written against.
 *
 * It travels *with* the batch rather than being assumed by whoever receives it,
 * because the Mac that has not been updated yet keeps emitting the old shape and the
 * one that has must still understand it. Bump this whenever a column that appears in
 * an op is renamed, dropped or changes meaning — adding a column needs no bump,
 * because an op that never mentions it leaves it at its default.
 *
 * See `db/upcast.ts`. The chain is empty today and costs nothing while it is; it
 * exists from the first version so that no op is ever written unversioned.
 */
export const SCHEMA_VERSION = 1

export type OpKind = 'put' | 'delete'

export interface Op {
  table: SyncedTable
  /** Text rather than uuid so key-addressed rows (settings) can use this too. */
  rowId: string
  kind: OpKind
  /** Changed columns only, snake_case, exactly as they are named in the database. */
  fields?: Record<string, unknown>
  hlc: string
}

export interface Batch {
  id: string
  /**
   * The stream this belongs to. Null only for a row that belongs to no workspace,
   * which today means nothing — every synced table reaches a workspace through the
   * chain below, and that is enforced rather than assumed.
   */
  workspaceId: string | null
  deviceId: string
  /** Null until accounts exist. Then: who, not merely which machine. */
  actorId: string | null
  schema: number
  hlc: string
  ops: Op[]
}

/* ------------------------------------------------------------------ *
 * What syncs
 * ------------------------------------------------------------------ */

export type SyncedTable =
  | 'workspace' | 'workspace_link' | 'project_folder' | 'project_collapsible' | 'project'
  | 'board_column' | 'person' | 'membership' | 'task' | 'content_folder' | 'note'
  | 'meeting' | 'meeting_attendee' | 'meeting_todo' | 'decision' | 'link'
  | 'journal_entry' | 'activity' | 'notification' | 'conversation' | 'chat_message'
  | 'chat_attachment' | 'recording' | 'recording_segment' | 'transcript_cue'

interface TableMeta {
  /**
   * How this row reaches its workspace. Null means the row *is* the workspace.
   *
   * Walked rather than denormalised: a `workspace_id` copied onto every table would
   * be a second answer to a question the foreign keys already answer, and the two
   * would eventually disagree.
   */
  owner: { column: string; table: SyncedTable } | null
  /**
   * Columns that are true of *this machine* and must never leave it.
   *
   * The recording pipeline is the whole of it, and it matters: sync
   * `transcript_state` and both Macs pick the same segment up, transcribe it, and
   * both pay for it. Results are content and do sync; the runner's own bookkeeping
   * is not.
   */
  deviceOnly?: readonly string[]
}

const RECORDING_PIPELINE = [
  'capture_state', 'heartbeat_at',
  'transcript_state', 'transcript_error', 'transcript_attempts',
  'speaker_state', 'speaker_error', 'speaker_attempts',
  'summary_state', 'summary_error', 'summary_attempts',
  'next_attempt_at'
] as const

export const TABLES: Record<SyncedTable, TableMeta> = {
  workspace:           { owner: null },
  workspace_link:      { owner: { column: 'workspace_id', table: 'workspace' } },
  project_folder:      { owner: { column: 'workspace_id', table: 'workspace' } },
  project_collapsible: { owner: { column: 'workspace_id', table: 'workspace' } },
  project:             { owner: { column: 'workspace_id', table: 'workspace' } },
  person:              { owner: { column: 'workspace_id', table: 'workspace' } },
  notification:        { owner: { column: 'workspace_id', table: 'workspace' } },
  conversation:        { owner: { column: 'workspace_id', table: 'workspace' } },

  board_column:        { owner: { column: 'project_id', table: 'project' } },
  membership:          { owner: { column: 'project_id', table: 'project' } },
  task:                { owner: { column: 'project_id', table: 'project' } },
  content_folder:      { owner: { column: 'project_id', table: 'project' } },
  note:                { owner: { column: 'project_id', table: 'project' } },
  meeting:             { owner: { column: 'project_id', table: 'project' } },
  decision:            { owner: { column: 'project_id', table: 'project' } },
  link:                { owner: { column: 'project_id', table: 'project' } },
  journal_entry:       { owner: { column: 'project_id', table: 'project' } },
  activity:            { owner: { column: 'project_id', table: 'project' } },

  meeting_attendee:    { owner: { column: 'meeting_id', table: 'meeting' } },
  meeting_todo:        { owner: { column: 'meeting_id', table: 'meeting' } },
  recording:           { owner: { column: 'meeting_id', table: 'meeting' }, deviceOnly: RECORDING_PIPELINE },

  chat_message:        { owner: { column: 'conversation_id', table: 'conversation' } },
  chat_attachment:     { owner: { column: 'conversation_id', table: 'conversation' } },

  /*
   * `segment_id` says which local audio file a line came from — and
   * `recording_segment` is a device table, so on any other machine that row does not
   * exist and never will. Sending it would mean every cue arriving with a foreign key
   * pointing at nothing: dropped on arrival, and a transcript that syncs as silence.
   * The words, their times and their speaker are the content; which file on which
   * disk they were read out of is not.
   */
  /*
   * The segments sync so that the audio can. Which file a line of transcript came
   * out of, and how long each piece is, are facts about the recording; the runner's
   * own state — whether *this* machine has transcribed it yet, and how many times it
   * has tried — is not, and stays here.
   *
   * `path` travels because it is a uuid filename assigned once and never changed, so
   * it is the same name on every device: that is what lets both of them derive the
   * same object key for the same file without asking each other.
   */
  recording_segment:   {
    owner: { column: 'recording_id', table: 'recording' },
    deviceOnly: ['state', 'error', 'attempts']
  },

  transcript_cue:      { owner: { column: 'recording_id', table: 'recording' } }
}

export const isSynced = (table: string): table is SyncedTable => table in TABLES

/**
 * Tables that deliberately produce no ops at all.
 *
 * `summary_part` is the slices a summary is
 * * built from, with their own state, error and attempt count. What comes *out* of it
 * — `recording.summary` and `recording.recap` — is content and does sync. Sync the
 * scaffolding too and two Macs would both summarise the same slice.
 *
 * `setting` is split by key instead — see below.
 */
export const DEVICE_TABLES = ['summary_part', 'setting'] as const

/**
 * The only settings that mean the same thing on every machine.
 *
 * `setting` is a flat key/value table that mixes machine facts (panel widths, the
 * data folder, which version was last announced) with genuine preferences, so the
 * seam has to be drawn by hand. These two change what *attention itself means*:
 * two devices disagreeing about them would give two different answers to the same
 * question, which is the one thing a derived value must never do. Everything else —
 * widths, theme, glass, notification hour, quiet hours, the update channel — is a
 * fact about a machine and stays on it.
 */
export const SYNCED_SETTINGS = ['horizonDays', 'staleAfterDays'] as const

/**
 * Every column the log deliberately does not carry, across all tables.
 *
 * Exported so a test asking "did replay reproduce this?" reads the answer off the
 * same declaration the applier does, rather than keeping a list beside it that goes
 * stale the first time a column changes sides.
 */
export const DEVICE_ONLY_COLUMNS: string[] = [
  ...new Set(Object.values(TABLES).flatMap((meta) => [...(meta.deviceOnly ?? [])]))
]

/** Fields that are never written from an op, whoever sent it. */
export const IMMUTABLE_FIELDS = ['id'] as const

export function syncableFields(
  table: SyncedTable,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const local = TABLES[table].deviceOnly
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if ((IMMUTABLE_FIELDS as readonly string[]).includes(k)) continue
    if (local?.includes(k)) continue
    out[k] = v
  }
  return out
}
