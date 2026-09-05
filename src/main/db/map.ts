import type {
  Activity, Attachment, BoardColumn, CastMember, ChatMessage, Conversation, Decision,
  JournalEntry, Link, Membership, MeetingTodo, MeetingView, Note, Person, PersonProject,
  Project, ProjectStatus, Recap, RecordingSegment, RecordingView, SpeakerName, Task,
  TaskView, TranscriptCue, Workspace
} from '@shared/types'
import { EMPTY_RECAP } from '@shared/types'
import type { CaptureState, Engine, Stage } from '@shared/recording'
import { hasTimestamps } from '@shared/recording'
import { daysBetween, iso, isoOrNull, today } from './client'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

export const mapWorkspace = (r: Row, icon: string | null = null): Workspace => ({
  id: r.id,
  name: r.name,
  color: r.color,
  iconPath: r.icon_path ?? '',
  icon,
  sortOrder: r.sort_order,
  archivedAt: isoOrNull(r.archived_at),
  // Whether there is a key, never the key. It stays in the database with everything
  // else main owns, and the renderer is told only that the assistant can run.
  aiKeySet: Boolean(r.ai_api_key),
  aiModel: r.ai_model ?? '',
  transcribeEngine: (r.transcribe_engine ?? 'openai') as Engine,
  transcribeModel: r.transcribe_model ?? '',
  transcribeBaseUrl: r.transcribe_base_url ?? '',
  transcribeLanguage: r.transcribe_language ?? '',
  recapEngine: (r.recap_engine ?? 'openai') as Engine,
  recapModel: r.recap_model ?? '',
  recapBaseUrl: r.recap_base_url ?? '',
  recapPrompt: r.recap_prompt ?? '',
  createdAt: iso(r.created_at)
})

export const mapProject = (r: Row, icon: string | null = null): Project => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  summary: r.summary,
  iconPath: r.icon_path ?? '',
  icon,
  color: r.color ?? '',
  deadline: r.deadline ?? null,
  status: r.status as ProjectStatus,
  isPinned: r.is_pinned,
  lastOpenedAt: isoOrNull(r.last_opened_at),
  previousOpenedAt: isoOrNull(r.previous_opened_at),
  lastActivityAt: iso(r.last_activity_at),
  createdAt: iso(r.created_at),
  archivedAt: isoOrNull(r.archived_at)
})

export const mapColumn = (r: Row): BoardColumn => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  sortOrder: r.sort_order,
  isDone: r.is_done,
  createdAt: iso(r.created_at)
})

export const mapPerson = (r: Row, avatar: string | null = null): Person => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  org: r.org,
  email: r.email,
  phone: r.phone,
  timezone: r.timezone,
  avatarColor: r.avatar_color,
  avatarPath: r.avatar_path ?? '',
  avatar,
  isMe: r.is_me ?? false,
  howToWorkWith: r.how_to_work_with,
  notes: r.notes,
  createdAt: iso(r.created_at)
})

export const mapMembership = (r: Row): Membership => ({
  id: r.id,
  personId: r.person_id,
  projectId: r.project_id,
  role: r.role,
  note: r.note,
  createdAt: iso(r.created_at)
})

export const mapCast = (r: Row, avatar: string | null = null): CastMember => ({
  ...mapMembership(r),
  name: r.name,
  org: r.org,
  email: r.email,
  avatarColor: r.avatar_color,
  avatar,
  isMe: r.is_me ?? false,
  howToWorkWith: r.how_to_work_with
})

export const mapPersonProject = (r: Row): PersonProject => ({
  ...mapMembership(r),
  projectName: r.project_name,
  projectStatus: r.project_status as ProjectStatus,
  workspaceName: r.workspace_name,
  workspaceColor: r.workspace_color
})

export const mapTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  details: r.details,
  kind: r.kind,
  status: r.status,
  columnId: r.column_id ?? null,
  dueDate: r.due_date,
  assigneePersonId: r.assignee_person_id ?? null,
  completedAt: isoOrNull(r.completed_at),
  sortOrder: r.sort_order,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapTaskView = (r: Row): TaskView => {
  const now = today()
  return {
    ...mapTask(r),
    projectName: r.project_name,
    projectColor: r.project_color ?? '',
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    workspaceColor: r.workspace_color,
    assigneeName: r.assignee_name ?? null,
    assigneeAvatar: r.assignee_avatar ?? null,
    assigneeColor: r.assignee_color ?? null,
    assigneeIsMe: r.assignee_is_me ?? false,
    daysUntilDue: r.due_date ? daysBetween(now, r.due_date) : null
  }
}

export const mapNote = (r: Row): Note => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  body: r.body,
  isPinned: r.is_pinned,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapMeetingTodo = (r: Row): MeetingTodo => ({
  id: r.id,
  meetingId: r.meeting_id,
  text: r.text,
  done: r.done ?? false,
  taskId: r.task_id ?? null,
  taskColumn: r.task_column ?? null,
  sortOrder: r.sort_order
})

/** jsonb comes back parsed; a row written by an older build could still be a string. */
const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export const mapSegment = (r: Row): RecordingSegment => ({
  id: r.id,
  ord: Number(r.ord),
  offsetMs: Number(r.offset_ms ?? 0),
  durationMs: Number(r.duration_ms ?? 0),
  bytes: Number(r.bytes ?? 0),
  hasAudio: Boolean(r.path),
  state: (r.state ?? 'pending') as Stage,
  error: r.error ?? ''
})

export const mapCue = (r: Row): TranscriptCue => ({
  id: r.id,
  ord: Number(r.ord),
  startMs: Number(r.start_ms ?? 0),
  endMs: Number(r.end_ms ?? 0),
  speaker: r.speaker ?? '',
  text: r.text ?? ''
})

/**
 * The recording as the screen reads it. Every count it shows — how far transcription
 * has got, how many megabytes are on disk — is worked out from the segment rows here
 * rather than stored on the recording, so the two can never disagree.
 */
export const mapRecording = (r: Row, segments: RecordingSegment[]): RecordingView => ({
  id: r.id,
  meetingId: r.meeting_id,
  captureState: (r.capture_state ?? 'stopped') as CaptureState,
  startedAt: iso(r.started_at),
  stoppedAt: isoOrNull(r.stopped_at),
  durationMs: Number(r.duration_ms ?? 0),
  bytes: segments.reduce((total, s) => total + (s.hasAudio ? s.bytes : 0), 0),
  audioDeletedAt: isoOrNull(r.audio_deleted_at),
  segments,

  transcriptState: (r.transcript_state ?? 'pending') as Stage,
  transcriptError: r.transcript_error ?? '',
  transcriptEngine: r.transcript_engine ?? '',
  transcriptModel: r.transcript_model ?? '',
  transcribed: segments.filter((s) => s.state === 'done').length,
  segmentCount: segments.length,
  hasTimestamps: hasTimestamps(r.transcript_model ?? ''),

  speakerState: (r.speaker_state ?? 'pending') as Stage,
  speakers: json<Record<string, SpeakerName>>(r.speakers, {}),

  summaryState: (r.summary_state ?? 'pending') as Stage,
  summaryError: r.summary_error ?? '',
  summaryEngine: r.summary_engine ?? '',
  summaryModel: r.summary_model ?? '',
  summary: r.summary ?? '',
  recap: { ...EMPTY_RECAP, ...json<Partial<Recap>>(r.recap, {}) },
  recapWrittenAt: isoOrNull(r.recap_written_at),

  updatedAt: iso(r.updated_at)
})

export const mapMeeting = (r: Row): MeetingView => {
  const todos = (r.todos ?? []).map(mapMeetingTodo)
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    occurredOn: r.occurred_on,
    body: r.body,
    attendees: r.attendees ?? [],
    todos,
    // Attached by `meetingViews`, which fetches recordings as rows rather than as
    // JSON so their timestamps go through the same mapping as everything else.
    recording: null,
    openTodos: todos.filter((t: MeetingTodo) => !t.done).length,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  }
}

export const mapDecision = (r: Row): Decision => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  rationale: r.rationale,
  alternatives: r.alternatives,
  decidedBy: r.decided_by,
  decidedOn: r.decided_on,
  createdAt: iso(r.created_at)
})

export const mapLink = (r: Row): Link => ({
  id: r.id,
  projectId: r.project_id,
  label: r.label,
  url: r.url,
  kind: r.kind,
  sortOrder: r.sort_order
})

export const mapJournal = (r: Row): JournalEntry => ({
  id: r.id,
  projectId: r.project_id,
  body: r.body,
  occurredOn: r.occurred_on,
  createdAt: iso(r.created_at)
})

export const mapActivity = (r: Row): Activity => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  summary: r.summary,
  createdAt: iso(r.created_at)
})

export const mapConversation = (r: Row): Conversation => ({
  id: r.id,
  workspaceId: r.workspace_id,
  title: r.title ?? '',
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
})

export const mapAttachment = (r: Row): Attachment => ({
  id: r.id,
  messageId: r.message_id ?? null,
  name: r.name ?? '',
  mime: r.mime ?? '',
  bytes: r.bytes ?? 0,
  path: r.path ?? ''
})

export const mapChatMessage = (r: Row, attachments: Attachment[] = []): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  // jsonb comes back parsed, but a row written by an older build could be a string.
  blocks: typeof r.blocks === 'string' ? JSON.parse(r.blocks) : (r.blocks ?? []),
  tools: typeof r.tools === 'string' ? JSON.parse(r.tools) : (r.tools ?? {}),
  attachments,
  sortOrder: r.sort_order,
  createdAt: iso(r.created_at)
})
