/**
 * The contract between the Electron main process and the renderer.
 * Everything that crosses the IPC bridge is described here.
 */

import type { CaptureState, Engine, Stage } from './recording'

export type ProjectStatus = 'active' | 'paused' | 'dormant' | 'done'

/**
 * `task`      — I do it.
 * `delegated` — someone else does it, I track it.
 *
 * Derived from the assignee rather than chosen, so the two cannot disagree.
 */
export type TaskKind = 'task' | 'delegated'
export type TaskStatus = 'open' | 'done' | 'cancelled'

/** A column on a project's board. Projects define their own. */
export interface BoardColumn {
  id: string
  projectId: string
  name: string
  sortOrder: number
  /** The terminal column: cards here are done. */
  isDone: boolean
  createdAt: string
}

export type LinkKind =
  | 'repo' | 'board' | 'design' | 'docs' | 'chat' | 'drive' | 'staging' | 'other'
export type ActivityKind =
  | 'task_created' | 'task_completed' | 'note' | 'decision' | 'journal' | 'meeting'
  | 'state_updated' | 'person_added' | 'link_added' | 'project_created'

export interface Workspace {
  id: string
  name: string
  color: string
  /** Filename inside the icons/ folder; empty when the workspace uses its colour. */
  iconPath: string
  /** The icon read back as a data URL, so the renderer needs no filesystem access. */
  icon: string | null
  sortOrder: number
  /** Archived means out of the way, not gone: hidden everywhere, restorable in one click. */
  archivedAt: string | null
  /**
   * Whether an API key has been saved for this workspace. Never the key: that stays
   * in the main process alongside the database, and the renderer is only ever told
   * that there is one.
   */
  aiKeySet: boolean
  /** Which model the assistant runs on. Empty means the default. */
  aiModel: string
  /**
   * How this workspace turns a recording into words and then into a recap. It is a
   * workspace setting for the same reason the key is: a client's conversations may
   * not be allowed to leave the machine while the day job's happily can, and that is
   * a decision you make once per working life rather than once per meeting.
   */
  transcribeEngine: Engine
  transcribeModel: string
  transcribeBaseUrl: string
  /** ISO 639-1, e.g. "no". Empty lets the model work it out. */
  transcribeLanguage: string
  recapEngine: Engine
  recapModel: string
  recapBaseUrl: string
  /** What the recap is asked for. Empty means the default in `shared/recording.ts`. */
  recapPrompt: string
  createdAt: string
}

/**
 * A drawer to file projects in, and nothing more.
 *
 * It carries no dates, no state and no work of its own: a folder cannot be overdue,
 * cannot need a look, and never appears in Today, search or the weekly review. It is
 * filing you do because *you* find it useful, which is why nothing in the app reads
 * it back and asks you to keep it true.
 *
 * `parentId` is what makes subfolders, and it is the only relationship there is.
 * Folders belong to a workspace like everything else does.
 */
export interface ProjectFolder {
  id: string
  workspaceId: string
  /** Null at the top level. */
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
}

/** A folder with its place in the tree worked out — what a list view needs. */
export interface ProjectFolderView extends ProjectFolder {
  /** Names from the top down, this folder last: `["Clients", "Acme"]`. */
  path: string[]
  /** How many levels down it sits. Top-level folders are 0. */
  depth: number
  /** Projects filed directly in it — not counting its subfolders'. */
  projectCount: number
  /** Folders filed directly in it. */
  folderCount: number
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  summary: string
  /** Optional uploaded mark; without one the project shows its initial. */
  iconPath: string
  icon: string | null
  /**
   * How you pick this project out of a grid of them. Empty means it inherits the
   * workspace's colour, so a project only carries one once you have decided it needs
   * to stand apart from its neighbours.
   */
  color: string
  /** The date the whole project has to land, as YYYY-MM-DD. Separate from any task. */
  deadline: string | null
  status: ProjectStatus
  /**
   * The folder it is filed in, or null for the ones sitting loose at the top of the
   * page. Filing is optional and always reversible; nothing else in the app changes
   * because of it.
   */
  folderId: string | null
  isPinned: boolean
  lastOpenedAt: string | null
  previousOpenedAt: string | null
  lastActivityAt: string
  createdAt: string
  archivedAt: string | null
}

/** A project row decorated with everything the list views need. */
export interface ProjectSummary extends Project {
  workspaceName: string
  workspaceColor: string
  openTasks: number
  overdueTasks: number
  nextDue: string | null
  peopleCount: number
  /** Your own roles on this project, comma separated — the hat you wear here. */
  myRoles: string
  /** A few faces for the card, you first. */
  castPreview: { name: string; color: string; avatar: string | null; role: string }[]
  /**
   * The one fact that makes this project want a look — something overdue, a deadline
   * closing in, or nothing having moved for a week — or null when there is nothing
   * to say. Derived from the work itself; there is no status to keep up to date.
   */
  attention: string | null
}

export interface Person {
  id: string
  /** People belong to a workspace — no screen ever mixes two of them. */
  workspaceId: string
  name: string
  org: string
  email: string
  phone: string
  timezone: string
  avatarColor: string
  /** Optional uploaded photo; without one the coloured initials are used. */
  avatarPath: string
  avatar: string | null
  /** You. One per workspace, kept in step with your profile. */
  isMe: boolean
  /** Free text: "prefers Slack", "no meetings before 10", "actually approves budget". */
  howToWorkWith: string
  notes: string
  createdAt: string
}

export interface Membership {
  id: string
  personId: string
  projectId: string
  role: string
  note: string
  createdAt: string
}

/** A membership joined with the person — what a project's cast panel renders. */
export interface CastMember extends Membership {
  name: string
  org: string
  email: string
  avatarColor: string
  avatar: string | null
  isMe: boolean
  howToWorkWith: string
}

/** A membership joined with the project — what a person's page renders. */
export interface PersonProject extends Membership {
  projectName: string
  projectStatus: ProjectStatus
  workspaceName: string
  workspaceColor: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  details: string
  kind: TaskKind
  status: TaskStatus
  columnId: string | null
  dueDate: string | null
  assigneePersonId: string | null
  completedAt: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** A task decorated with its project, workspace and blocking person. */
export interface TaskView extends Task {
  projectName: string
  /**
   * The project's own colour, empty until it has been given one. Paired with
   * `workspaceColor` through `projectColor()`, this is what lets a list of items
   * from six projects be grouped by eye — the workspace colour alone is the same
   * on every row of a workspace-fenced screen, which is every screen there is.
   */
  projectColor: string
  workspaceId: string
  workspaceName: string
  workspaceColor: string
  assigneeName: string | null
  assigneeAvatar: string | null
  assigneeColor: string | null
  assigneeIsMe: boolean
  /** Negative = overdue by n days, 0 = today, positive = n days away. */
  daysUntilDue: number | null
}

export interface Note {
  id: string
  projectId: string
  title: string
  body: string
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export interface Meeting {
  id: string
  projectId: string
  title: string
  occurredOn: string
  /** Markdown, written on a page rather than typed into a box. Same as a note. */
  body: string
  createdAt: string
  updatedAt: string
}

/**
 * Something the meeting left owing. It starts on the meeting, because that is where
 * it was said, and stays there until you decide it is real work — at which point it
 * becomes a card and the card is the one that knows whether it is finished.
 */
export interface MeetingTodo {
  id: string
  meetingId: string
  text: string
  /** Ticked. Once the item is on the board the card answers this, not the item. */
  done: boolean
  /** The card this became, if it was put on the board. */
  taskId: string | null
  /** The column that card is sitting in — what a promoted item shows instead of a box. */
  taskColumn: string | null
  sortOrder: number
}

export interface MeetingView extends Meeting {
  /** The recording, if this meeting was recorded. Null is the normal case. */
  recording: RecordingView | null
  attendees: { id: string; name: string; color: string; avatar: string | null; role: string }[]
  todos: MeetingTodo[]
  /** Still owed. The meeting list shows this without you having to open anything. */
  openTodos: number
}

/* ------------------------------------------------------------------ recording */

/**
 * One file of audio. A recording is a *sequence* of these rather than one file,
 * which is the whole reason it survives a machine losing power: a segment is closed
 * and accounted for every five minutes, and again whenever capture is interrupted
 * and picked back up, so what is on disk is always a set of complete, playable,
 * transcribable files plus at most one that is still being written.
 */
export interface RecordingSegment {
  id: string
  ord: number
  /** Where this segment starts on the recording's own timeline, in milliseconds. */
  offsetMs: number
  durationMs: number
  bytes: number
  /** False once the audio has been deleted and only the words are left. */
  hasAudio: boolean
  /** Transcription is per segment, so an interrupted run resumes at the right one. */
  state: Stage
  error: string
}

/** One phrase, timed against the whole recording rather than against its segment. */
export interface TranscriptCue {
  id: string
  ord: number
  startMs: number
  endMs: number
  /** "Speaker 1", or a real name once one has been put to it. Empty until attributed. */
  speaker: string
  text: string
}

export interface RecapCommitment {
  who: string
  what: string
  /** YYYY-MM-DD, and only when a date was actually said. */
  due: string
}

/**
 * What the meeting produced, as data rather than prose, because the screen acts on
 * it: a commitment becomes a to-do in one click, and a decision can be filed in the
 * decision log without being retyped.
 */
export interface Recap {
  decisions: { what: string; who: string }[]
  commitments: RecapCommitment[]
  insights: string[]
}

export const EMPTY_RECAP: Recap = { decisions: [], commitments: [], insights: [] }

/** A speaker label with whatever has been put to it. */
export interface SpeakerName {
  name: string
  personId: string | null
}

export interface RecordingView {
  id: string
  meetingId: string
  captureState: CaptureState
  startedAt: string
  stoppedAt: string | null
  /** Sound actually captured, which is not the wall clock if capture was interrupted. */
  durationMs: number
  /** On disk right now. Zero once the audio has been deleted. */
  bytes: number
  audioDeletedAt: string | null
  segments: RecordingSegment[]

  transcriptState: Stage
  transcriptError: string
  transcriptEngine: string
  transcriptModel: string
  /** Segments transcribed out of segments there are, for a progress line in words. */
  transcribed: number
  segmentCount: number
  /** False when the transcription model returned no times, so playback cannot follow. */
  hasTimestamps: boolean

  speakerState: Stage
  speakers: Record<string, SpeakerName>

  summaryState: Stage
  summaryError: string
  summaryEngine: string
  summaryModel: string
  /** The prose part of the recap, in Markdown. */
  summary: string
  recap: Recap
  /**
   * When the recap was folded into the meeting — appended to the write-up, used to
   * name it if it had no name, and turned into its to-do items. Null means that has
   * not happened yet, which is a thing the screen must not claim before it is true.
   */
  recapWrittenAt: string | null

  updatedAt: string
}

/**
 * What main pushes at the window while a recording is being worked on. The pipeline
 * runs whether or not anything is on screen — that is the point of it — so the
 * renderer is told when something moved rather than polling for it.
 */
export type RecordingEvent =
  | { type: 'changed'; recordingId: string; meetingId: string }
  /** Capture stopped without being told to: the renderer has to let go of the mic. */
  | { type: 'interrupted'; recordingId: string; meetingId: string }

export interface Decision {
  id: string
  projectId: string
  title: string
  rationale: string
  alternatives: string
  decidedBy: string
  decidedOn: string
  createdAt: string
}

export interface Link {
  id: string
  projectId: string
  label: string
  url: string
  kind: LinkKind
  sortOrder: number
}

export interface JournalEntry {
  id: string
  projectId: string
  body: string
  occurredOn: string
  createdAt: string
}

export interface Activity {
  id: string
  projectId: string
  kind: ActivityKind
  summary: string
  createdAt: string
}

/** The "where were we" header shown at the top of every project. */
export interface ReentryBrief {
  daysSinceOpened: number | null
  daysSinceActivity: number
  isReturning: boolean
  changes: Activity[]
}

export interface ProjectDetail {
  project: ProjectSummary
  brief: ReentryBrief
  columns: BoardColumn[]
  tasks: TaskView[]
  cast: CastMember[]
  links: Link[]
  notes: Note[]
  meetings: MeetingView[]
  decisions: Decision[]
  journal: JournalEntry[]
  activity: Activity[]
}

/**
 * A meeting that still owes something. A to-do agreed in a room and never closed is
 * the easiest thing in the app to lose: it is not a card, so it is on no board, and
 * nothing about it is dated, so no overdue list will ever raise it. This is what
 * carries it up to Today rather than leaving it for you to remember to go and look.
 */
export interface MeetingOwing {
  meetingId: string
  projectId: string
  projectName: string
  projectColor: string
  title: string
  occurredOn: string
  openTodos: number
}

export interface TodayView {
  today: string
  overdue: TaskView[]
  dueToday: TaskView[]
  soon: TaskView[]
  needsAttention: ProjectSummary[]
  /** Meetings across the workspace with to-dos still open, newest first. */
  owedFromMeetings: MeetingOwing[]
  stats: { openTasks: number; activeProjects: number; peopleTracked: number }
}

export interface SearchHit {
  kind: 'project' | 'task' | 'person' | 'note' | 'decision' | 'journal'
  id: string
  projectId: string | null
  title: string
  subtitle: string
  snippet: string
  color: string
}

/** Who you are. One profile, mirrored into every workspace as a person. */
export interface Profile {
  name: string
  avatarPath: string
  avatar: string | null
}

export interface Settings {
  dataDir: string
  markdownDir: string
  /** Read-only, like the two paths above: reported by main, never written back. */
  appVersion: string
  /** Remembered across restarts so you land back where you were. */
  activeWorkspaceId: string
  /**
   * When the first-run flow was finished, as an ISO timestamp; empty until it is.
   * It only ever decides whether the app introduces itself: deleting your last
   * workspace later gets you the short "create a workspace" screen, not the pitch
   * for an app you have been using for a year.
   */
  onboardedAt: string
  theme: 'light' | 'dark' | 'system'
  staleAfterDays: number
  horizonDays: number
  /**
   * How wide you have dragged each side panel, in pixels: the navigation down the
   * left, the assistant down the right, and the meeting page's details column.
   * Bounds and defaults are in `shared/panels.ts`.
   */
  sidebarWidth: number
  assistantWidth: number
  meetingWidth: number
  /**
   * Try to record what the computer is playing as well as what the microphone
   * hears — the other half of a video call.
   */
  captureSystemAudio: boolean
  /**
   * The input device the computer's own sound arrives on, by name.
   *
   * Empty on Windows, where the operating system will hand an application its own
   * output directly and no device is involved. On macOS there is no such thing:
   * nothing but a virtual audio device can hear what another app is playing, so this
   * names the one to listen to — "BlackHole 2ch", an aggregate device, whatever you
   * have. Stored by name rather than by id because ids are opaque and change; a name
   * is the thing you would recognise in a list.
   */
  systemAudioDevice: string
}

/* ------------------------------------------------------------------ assistant */

/**
 * A chat with the assistant. Conversations belong to a workspace like everything
 * else — the assistant can only see the workspace it was opened in, so asking it
 * about your day job cannot pull an answer out of a client's project.
 */
export interface Conversation {
  id: string
  workspaceId: string
  /** Written by the model after the first exchange; empty until then. */
  title: string
  createdAt: string
  updatedAt: string
}

/** A file the user put into the conversation, stored beside the database. */
export interface Attachment {
  id: string
  messageId: string | null
  name: string
  mime: string
  bytes: number
  /** Filename inside attachments/. The renderer never sees a path it can read. */
  path: string
}

/**
 * What happened when the assistant used a tool, kept apart from the API content
 * blocks so those stay exactly what Claude sent and can be replayed unchanged.
 */
export interface ToolRecord {
  name: string
  /** What the tool did, in plain words. The same line the confirmation asked about. */
  label: string
  status: 'done' | 'declined' | 'error'
  detail: string
}

/**
 * One turn. `blocks` is the API's own content — text, tool_use, tool_result — so a
 * conversation reopened tomorrow replays to the model precisely as it was, and the
 * renderer derives what it draws from the same rows rather than a second copy.
 */
export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  /** Keyed by tool_use id. */
  tools: Record<string, ToolRecord>
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  blocks: any[]
  attachments: Attachment[]
  sortOrder: number
  createdAt: string
}

/** A file on its way in: read in the renderer, written to disk by main. */
export interface AttachmentUpload {
  name: string
  mime: string
  /** Base64, without the data: prefix. */
  data: string
}

/**
 * What the main process pushes at the panel while a turn is running. A reply is
 * streamed rather than awaited, so the answer is readable while it is still being
 * written, and a tool that wants to change something stops the run and asks.
 */
export type AiEvent =
  | { runId: string; type: 'text'; delta: string }
  | { runId: string; type: 'tool'; id: string; name: string; label: string; status: 'running' | 'done' | 'error'; detail: string }
  /** The run is now waiting. Nothing is written until `ai:respond` says so. */
  | { runId: string; type: 'approval'; id: string; name: string; label: string; detail: string }
  | { runId: string; type: 'title'; conversationId: string; title: string }
  /** The turn is over; the panel refetches and drops everything it was holding. */
  | { runId: string; type: 'done'; conversationId: string }
  | { runId: string; type: 'error'; message: string }
