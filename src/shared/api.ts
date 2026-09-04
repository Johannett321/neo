import type {
  Activity, BoardColumn, CastMember, Decision, JournalEntry, Lane, Link, LinkKind, Membership, Note,
  Meeting, MeetingView, Person, PersonProject, Project, ProjectDetail, ProjectStatus,
  ProjectSummary, Profile, SearchHit, Settings, Task, TaskKind, TaskStatus, TodayView, Workspace
} from './types'

/** Every scoped request names its workspace explicitly — there is no implicit "all". */
export interface ProjectFilter {
  workspaceId: string
  status?: ProjectStatus | 'all'
  query?: string
  /** Archived projects are excluded unless you ask for them explicitly. */
  archived?: boolean
}

export interface Scope {
  workspaceId: string
}

export interface TaskFilter {
  projectId?: string
  workspaceId?: string
  kind?: TaskKind
  status?: TaskStatus
}

export type Draft<T> = Partial<T> & { id?: string }

/**
 * Every IPC channel, with its input and output types. `window.api` is generated
 * from this map, so the renderer cannot call a channel that main does not handle.
 */
export interface ApiMap {
  'workspace:list': { in: void; out: Workspace[] }
  'workspace:save': { in: Draft<Workspace>; out: Workspace }
  'workspace:delete': { in: { id: string }; out: void }
  'workspace:reorder': { in: { ids: string[] }; out: void }
  'workspace:setArchived': { in: { id: string; archived: boolean }; out: Workspace }
  /**
   * Opens a file picker in the main process, copies the chosen image into the data
   * folder and hands back a data URL. Works before the workspace exists, so creating
   * and editing behave the same. Returns null if the picker was cancelled.
   */
  'icon:pick': { in: void; out: { iconPath: string; dataUrl: string } | null }

  'project:list': { in: ProjectFilter; out: ProjectSummary[] }
  'project:get': { in: { id: string; touch?: boolean }; out: ProjectDetail }
  'project:save': { in: Draft<Project>; out: Project }
  'project:setArchived': { in: { id: string; archived: boolean }; out: Project }
  'project:delete': { in: { id: string }; out: void }

  'lane:save': { in: Draft<Lane>; out: Lane }
  'lane:delete': { in: { id: string }; out: void }
  'lane:reorder': { in: { ids: string[] }; out: void }

  'task:list': { in: TaskFilter | void; out: import('./types').TaskView[] }
  'task:save': { in: Draft<Task>; out: Task }
  'task:setStatus': { in: { id: string; status: TaskStatus }; out: Task }
  /** Moving a card. Dropping into or out of the done column flips `status` too. */
  'task:setColumn': { in: { id: string; columnId: string }; out: Task }

  'column:save': { in: Draft<BoardColumn>; out: BoardColumn }
  'column:delete': { in: { id: string }; out: void }
  'column:reorder': { in: { ids: string[] }; out: void }
  'task:delete': { in: { id: string }; out: void }
  'task:reorder': { in: { ids: string[] }; out: void }

  'person:list': { in: Scope & { query?: string }; out: (Person & { projectCount: number })[] }
  'person:get': { in: { id: string }; out: { person: Person; projects: PersonProject[] } }
  'person:save': { in: Draft<Person>; out: Person }
  'person:delete': { in: { id: string }; out: void }

  'membership:save': { in: Draft<Membership>; out: CastMember }
  /** Every role already used in this workspace, so your own vocabulary is suggested back. */
  'membership:roles': { in: Scope; out: string[] }
  /** Set your own roles on a project, creating your membership if it is missing. */
  'membership:saveMine': { in: { projectId: string; role: string }; out: CastMember }
  'membership:delete': { in: { id: string }; out: void }

  'note:save': { in: Draft<Note>; out: Note }
  'note:delete': { in: { id: string }; out: void }

  'meeting:save': { in: Draft<Meeting> & { attendeeIds?: string[] }; out: MeetingView }
  'meeting:delete': { in: { id: string }; out: void }

  'decision:save': { in: Draft<Decision>; out: Decision }
  'decision:delete': { in: { id: string }; out: void }

  'link:save': { in: Draft<Link> & { kind?: LinkKind }; out: Link }
  'link:delete': { in: { id: string }; out: void }

  'journal:save': { in: Draft<JournalEntry>; out: JournalEntry }
  'journal:delete': { in: { id: string }; out: void }

  'dashboard:today': { in: Scope; out: TodayView }
  'dashboard:activity': { in: Scope & { limit?: number }; out: (Activity & { projectName: string; workspaceColor: string })[] }

  'search:query': { in: Scope & { q: string }; out: SearchHit[] }

  'profile:get': { in: void; out: Profile }
  'profile:save': { in: Partial<Profile>; out: Profile }

  'settings:get': { in: void; out: Settings }
  'settings:save': { in: Partial<Settings>; out: Settings }
  'settings:revealData': { in: void; out: void }
  'settings:exportMarkdown': { in: void; out: { files: number; dir: string } }
  'settings:exportJson': { in: void; out: { path: string } }
  'settings:loadSample': { in: void; out: void }
  'settings:wipe': { in: void; out: void }

  'shell:openExternal': { in: { url: string }; out: void }
}

export type Channel = keyof ApiMap
export type Input<C extends Channel> = ApiMap[C]['in']
export type Output<C extends Channel> = ApiMap[C]['out']

export type { ProjectStatus, TaskKind, TaskStatus }
