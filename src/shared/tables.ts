/**
 * What syncs, and how each table reaches the workspace it belongs to.
 *
 * This boundary's contract, the way `api.ts` is IPC's and `mcp.ts` is the socket's.
 * `db/apply.ts` is the only thing in the application that writes a domain table, and
 * this is the declaration it reads: a click, an assistant tool call, a task created
 * from Claude Desktop and a row arriving from the sync server all converge there,
 * which is what makes them the same write rather than four that resemble each other.
 *
 * Nothing here imports from main or the renderer. The phone reads the same
 * declaration without a Postgres anywhere near it.
 */

/**
 * One row, as it travels.
 *
 * A whole row rather than the columns that changed, which is the difference between
 * this and what it replaces. It costs the case where two devices edit different
 * fields of the same row while both are offline — one of the two edits is lost — and
 * it buys a server that stores rows in columns, a protocol anybody can read off the
 * wire, and no per-field bookkeeping table beside every write.
 */
export interface RowChange {
  table: SyncedTable
  /** Text rather than uuid so key-addressed rows (settings) could use this too. */
  id: string
  deleted: boolean
  /** When the device that wrote it last changed it. The whole of the conflict rule. */
  changedAt: string
  /** snake_case, exactly as the columns are named in the database. */
  fields: Record<string, unknown>
}

export type SyncedTable =
  | 'workspace' | 'workspace_link' | 'project_folder' | 'project_collapsible' | 'project'
  | 'board_column' | 'person' | 'membership' | 'task' | 'content_folder' | 'note'
  | 'canvas' | 'note_image' | 'meeting' | 'meeting_attendee' | 'meeting_todo' | 'decision' | 'link'
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
   * Mostly the recording pipeline, and it matters: sync `transcript_state` and both
   * Macs pick the same segment up, transcribe it, and both pay for it. Results are
   * content and do sync; the runner's own bookkeeping is not.
   */
  deviceOnly?: readonly string[]
  /**
   * Other synced tables this table references outside its owner chain.
   *
   * Used to order a push, so a referenced row is handed over before the row that
   * points at it; otherwise a project sent before its folder arrives on another
   * machine as a foreign-key violation and has to wait for the next page to be
   * placed.
   */
  references?: readonly SyncedTable[]
}

const RECORDING_PIPELINE = [
  'capture_state', 'heartbeat_at',
  'transcript_state', 'transcript_error', 'transcript_attempts',
  'speaker_state', 'speaker_error', 'speaker_attempts',
  'summary_state', 'summary_error', 'summary_attempts',
  'next_attempt_at'
] as const

export const TABLES: Record<SyncedTable, TableMeta> = {
  /*
   * `ai_api_key` travels with the rest of the workspace, and it is worth being clear
   * about what that means: it is an API key, and it is stored in plaintext on the
   * sync server, so whoever runs that server can read it. It is here because a
   * workspace's assistant should work on every device you own without setting it up
   * again on each one, and holding one column back to avoid that was a poor trade.
   *
   * It is the obvious first thing for selective encryption to carry. Until there is
   * some, a self-hosted server is the answer for anybody this does not suit.
   */
  workspace:           { owner: null },
  workspace_link:      { owner: { column: 'workspace_id', table: 'workspace' } },
  project_folder:      { owner: { column: 'workspace_id', table: 'workspace' } },
  project_collapsible: { owner: { column: 'workspace_id', table: 'workspace' } },
  project:             { owner: { column: 'workspace_id', table: 'workspace' }, references: ['project_folder', 'project_collapsible'] },
  person:              { owner: { column: 'workspace_id', table: 'workspace' } },
  notification:        { owner: { column: 'workspace_id', table: 'workspace' } },
  conversation:        { owner: { column: 'workspace_id', table: 'workspace' } },

  board_column:        { owner: { column: 'project_id', table: 'project' } },
  membership:          { owner: { column: 'project_id', table: 'project' } },
  task:                { owner: { column: 'project_id', table: 'project' }, references: ['board_column', 'person'] },
  content_folder:      { owner: { column: 'project_id', table: 'project' } },
  note:                { owner: { column: 'project_id', table: 'project' }, references: ['content_folder'] },
  canvas:              { owner: { column: 'project_id', table: 'project' }, references: ['content_folder'] },
  note_image:          { owner: { column: 'project_id', table: 'project' } },
  meeting:             { owner: { column: 'project_id', table: 'project' }, references: ['content_folder'] },
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
 * Every column that deliberately does not leave the machine, across all tables.
 *
 * Exported so a test asking "did this row survive a round trip?" reads the answer off
 * the same declaration the applier does, rather than keeping a list beside it that
 * goes stale the first time a column changes sides.
 */
export const DEVICE_ONLY_COLUMNS: string[] = [
  ...new Set(Object.values(TABLES).flatMap((meta) => [...(meta.deviceOnly ?? [])]))
]

/** Fields that are never written from an incoming row, whoever sent it. */
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
