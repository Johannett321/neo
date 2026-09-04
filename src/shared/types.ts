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
  startsAt: string
  location: string
  agenda: string
  body: string
  actions: string
  createdAt: string
  updatedAt: string
}

export interface MeetingView extends Meeting {
  attendees: { id: string; name: string; color: string; avatar: string | null; role: string }[]
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
  theme: 'light' | 'dark' | 'system'
  staleAfterDays: number
  horizonDays: number
}
