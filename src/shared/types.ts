/**
 * The contract between the Electron main process and the renderer.
 * Everything that crosses the IPC bridge is described here.
 */

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
  createdAt: string
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
  attendees: { id: string; name: string; color: string; avatar: string | null; role: string }[]
  todos: MeetingTodo[]
  /** Still owed. The meeting list shows this without you having to open anything. */
  openTodos: number
}

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

export interface TodayView {
  today: string
  overdue: TaskView[]
  dueToday: TaskView[]
  soon: TaskView[]
  needsAttention: ProjectSummary[]
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
  /** How wide you have dragged the assistant panel. */
  assistantWidth: number
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
