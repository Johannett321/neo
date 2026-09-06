import type { ClockFormat, DateFormat, TemperatureUnits } from './formats'
import type { UpdatePreference } from './update'

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

  /* --------------------------------------------------- the Today page's own look */

  /** Filename inside icons/, the photograph across the top of Today. Empty for none. */
  bannerPath: string
  /**
   * The banner as a URL the renderer can put in an `src`, or null when there is none.
   *
   * A `neo-media://` URL rather than a data URL, unlike the icon beside it, and for
   * one reason: an icon is a few kilobytes and a banner is a photograph. Handing a
   * megabyte of base64 across the bridge on every `workspace:list` — which every
   * mutation in the app invalidates — is a cost paid on every keystroke that saves.
   */
  banner: string | null
  /**
   * Which part of the banner is shown, as `object-position` percentages. A photograph
   * is rarely the shape of the strip it is drawn in, so most of one axis is cropped
   * away; these say which part survives. 50/50 is centred, and is what a banner that
   * has never been dragged shows.
   */
  bannerX: number
  bannerY: number
  /** A line about what you do in this working life. Markdown is not parsed here. */
  bio: string
  /**
   * Where the weather is read for. Empty means it is worked out from the machine's
   * own timezone, which is what makes it say something before anyone configures it.
   */
  weatherPlace: string
  weatherLatitude: number | null
  weatherLongitude: number | null
  /**
   * What Today is allowed to show. Overdue and due today are not in here: they are
   * the reason the screen exists, and one you can switch off is a wallpaper.
   */
  todayShowClock: boolean
  todayShowWeather: boolean
  todayShowBio: boolean
  todayShowLinks: boolean
  todayShowStats: boolean
  todayShowAttention: boolean
  todayShowMeetingTodos: boolean
  todayShowSoon: boolean

  /* ------------------------------------------------- what it is allowed to say */

  /**
   * Whether this working life may put anything on the desktop at all.
   *
   * Per workspace, because that is the unit a decision like this is actually made
   * in: a client you are on call for may nudge you and the side project may keep
   * quiet, and neither answer is right for both. The machine's own switch is in app
   * settings and wins over this one — that is the one you reach for on holiday.
   */
  notify: boolean
  /**
   * How many days before a project's own deadline you are told, and **zero means
   * never**. One number rather than a switch and a number beside it, so the two can
   * never disagree about whether this is on; turning it back on restores the
   * default rather than leaving you at nought days, which would say nothing.
   */
  notifyProjectAheadDays: number
  /** And again on the morning of the deadline itself. */
  notifyProjectOnTheDay: boolean
  /** The same two, for a due date on a card. Zero is off, exactly as above. */
  notifyTaskAheadDays: number
  notifyTaskOnTheDay: boolean
  /**
   * The morning after something was due and is still open. Once — the day after,
   * and never again. An item that has been late for three weeks is a fact about the
   * project, and Today is where a fact like that lives; a notification that repeats
   * until you act is how an app teaches you to dismiss it without reading.
   */
  notifyTaskDayAfter: boolean

  createdAt: string
}

/* -------------------------------------------------------------- notifications */

/**
 * The five moments Neo is willing to interrupt you at. All five are read off the
 * work — a deadline, a due date — so there is nothing here to keep true by hand,
 * exactly as there is nothing behind `attentionReason`.
 */
export type NotificationKind =
  | 'project-ahead'
  | 'project-day'
  | 'task-ahead'
  | 'task-day'
  | 'task-after'

/**
 * One thing worth saying out loud, already written. Derived on the way past and
 * never stored: what *is* stored is only that it has been said today, so it is not
 * said twice.
 *
 * One of these covers every item of its kind — "3 items are due tomorrow", not three
 * notifications — because a notification centre with nine cards in it from one app is
 * a notification centre you turn off.
 */
export interface PendingNotification {
  kind: NotificationKind
  workspaceId: string
  /** The fact, in the same plain words the attention line uses. */
  title: string
  /** Which project, or which items, and the working life it happened in. */
  body: string
  /** Where clicking it goes: a project when they all share one, Today otherwise. */
  path: string
  /** How many items it speaks for, so a screen can say so without recounting. */
  count: number
}

/** Where a clicked notification puts you. The workspace comes first: it may not be the one on screen. */
export interface OpenTarget {
  workspaceId: string
  path: string
}

/**
 * A link on the workspace's front page. Not a project's `Link`: it belongs to the
 * working life rather than to a piece of work, and it carries no kind, because the
 * kinds exist to tell a repository from a board and these are just the things you
 * open in the morning.
 */
export interface WorkspaceLink {
  id: string
  workspaceId: string
  label: string
  url: string
  sortOrder: number
}

/**
 * The weather where you are, as far as a forecast service will say. Everything here
 * is already in the workspace's own unit — the renderer draws a number, it does not
 * convert one.
 */
export interface WeatherNow {
  /** The place it is actually for, in words, so a wrong guess is visible. */
  place: string
  temperature: number
  high: number
  low: number
  /** Which unit it was actually fetched in, so the degree sign cannot disagree. */
  units: 'c' | 'f'
  /** WMO weather code, kept so the words and the icon come from one table. */
  code: number
  description: string
  isDay: boolean
  /** When it was fetched, so a stale reading can say so rather than pretend. */
  fetchedAt: string
}

/** A candidate place, from searching for one by name. */
export interface WeatherPlace {
  name: string
  region: string
  country: string
  latitude: number
  longitude: number
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

/**
 * A named band of project cards that folds away, on the page they are already on.
 *
 * The other half of grouping, and deliberately not a folder. A folder is somewhere you
 * *go*: clicking it replaces the page with what is filed inside it. A collapsible is
 * somewhere things *are*: it sits under the loose cards at the level you are looking
 * at, named, with its projects still on the screen until you fold it shut. Which one
 * you want depends on whether you still need to see the work — filing it away and
 * putting it below the fold are different answers to different questions, so they are
 * different things rather than one thing with a flag.
 *
 * It is furniture, like `Project.sortOrder` and for the same reason: nothing in the app
 * reads it back, nothing derives from it, and it never reaches the Markdown mirror. A
 * collapsible that has gone stale costs you a card in the wrong band.
 *
 * `folderId` is the level it lives at — null at the top, otherwise the folder it is
 * drawn in — and it does not move once made. Every project in it is at that same level,
 * which is what keeps the two ways of grouping from arguing: filing a card elsewhere
 * takes it out of its band, because the band was somewhere else.
 */
export interface ProjectCollapsible {
  id: string
  workspaceId: string
  /** Null at the top level; otherwise the folder whose page it is drawn on. */
  folderId: string | null
  name: string
  sortOrder: number
  /** Folded shut. Remembered, because the point of folding is that it stays folded. */
  isCollapsed: boolean
  createdAt: string
}

/** A collapsible with what is in it counted — what the header shows when it is shut. */
export interface ProjectCollapsibleView extends ProjectCollapsible {
  /** Projects in it, not counting archived ones. */
  projectCount: number
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
  /**
   * The collapsible band it is drawn in, or null for the loose cards above them all.
   * Independent of `folderId`: a project is filed in a folder and grouped in a band on
   * that folder's page. Filing it somewhere else clears this, since the band it was in
   * belongs to the level it left.
   */
  collapsibleId: string | null
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

/**
 * The two lists inside a project that are long enough to want filing: the notes and
 * the meetings. One word for both because they are the same shape of thing — a page
 * of Markdown with a name on it — and because it is what lets one folder table, one
 * set of handlers and one set of screens serve both rather than two of each that
 * drift apart.
 */
export type ContentKind = 'note' | 'meeting'

/**
 * Somewhere to file notes, or somewhere to file meetings. It is the project-scoped
 * twin of `ProjectFolder`, and it is filing and only filing for the same reason: no
 * dates, no state, no work of its own, and nothing in the app derives anything from
 * it. A folder that has gone stale costs you a note in the wrong place, never a wrong
 * answer — which is the whole licence for the user maintaining it by hand.
 *
 * `kind` is what keeps the two trees apart. A note is never filed in a folder made for
 * meetings, and the two lists never see each other's folders; one table holds both
 * because everything about them is the same but the word on the screen.
 */
export interface ContentFolder {
  id: string
  projectId: string
  /** Which list this folder belongs to. The two trees never touch. */
  kind: ContentKind
  /** Null at the top level of its list. */
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
}

/** A content folder with its place in the tree worked out — what a list view needs. */
export interface ContentFolderView extends ContentFolder {
  /** Names from the top down, this folder last: `["Steering", "2024"]`. */
  path: string[]
  /** How many levels down it sits. Top-level folders are 0. */
  depth: number
  /** Notes or meetings filed directly in it — not counting its subfolders'. */
  itemCount: number
  /** Folders filed directly in it. */
  folderCount: number
}

export interface Note {
  id: string
  projectId: string
  title: string
  body: string
  /** The folder it is filed in, or null for the notes sitting loose at the top. */
  folderId: string | null
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
  /** The folder it is filed in, or null for the meetings sitting loose at the top. */
  folderId: string | null
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
  /*
   * The two folder trees, fetched with everything else rather than through a list
   * channel of their own: a project's folders are as much part of opening a project as
   * its notes are, and there are tens of them, not thousands. Depth-first, in the
   * order the pages draw them, each already carrying its path.
   */
  noteFolders: ContentFolderView[]
  meetingFolders: ContentFolderView[]
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
  /**
   * The palette, plus one material.
   *
   * `light`, `dark` and `system` choose a palette and nothing else. `glass` is not a
   * fourth palette: it takes its colours from the operating system exactly as
   * `system` does and turns the window itself into a translucent surface, which is
   * why it carries an amount below and the other three do not.
   */
  theme: 'light' | 'dark' | 'system' | 'glass'
  /**
   * How much of what is behind the window shows through it, 0-100, and read only
   * while the theme is `glass`. Zero is the app as it looks in every other theme —
   * the material is still there, and nothing passes through it.
   */
  glassTransparency: number
  /**
   * How the time, the date and the temperature read. On this machine rather than on
   * a workspace: which working life you are in changes the photograph at the top of
   * Today, not whether you count hours to twelve or to twenty-four.
   *
   * `system` everywhere by default, which means whatever the operating system already
   * says — the right answer for almost everybody, and the reason these are three
   * quiet choices rather than a setup step.
   */
  clockFormat: ClockFormat
  dateFormat: DateFormat
  temperatureUnits: TemperatureUnits
  /**
   * Whether this machine may show a desktop notification at all.
   *
   * The master switch, and an app setting rather than a workspace one for the same
   * reason the clock format is: it is about the computer in front of you and the
   * week you are having, not about which working life the work belongs to. Off here
   * silences every workspace; on here lets each of them answer for itself.
   */
  notifications: boolean
  /**
   * When in the morning they arrive, as `HH:MM` on a 24-hour clock regardless of how
   * you have asked for a clock to be *drawn*.
   *
   * There is one delivery a day and this is it. A deadline is a calendar fact, not an
   * event — nothing about it happens at 14:07 — so the honest shape is a single quiet
   * moment when you are told what is coming, and silence for the rest of the day. If
   * the machine was asleep at the time, it is said when the machine comes back.
   */
  notifyAt: string
  /** Whether that delivery happens on a Saturday or a Sunday. Off, by default. */
  notifyWeekends: boolean
  /**
   * How much of updating itself the app is allowed to do without being asked.
   *
   * `automatic` — the default — checks, downloads and swaps the application on the
   * way out, so the version you are running is the current one and nobody ever drags
   * anything anywhere. `notify` does everything up to the download and waits to be
   * told. `off` makes **no request at all**, which is the same rule the weather is
   * held to: switched off is silence, not a request whose answer is thrown away.
   */
  updates: UpdatePreference
  /**
   * The version whose changelog has been read, so the "what's new" screen is shown
   * once per update and never on a fresh install.
   *
   * Empty until the first launch after this feature shipped — which is deliberately
   * indistinguishable from a new install, because somebody's *first* sight of Neo
   * should not be a list of what changed in a version they never ran.
   */
  lastSeenVersion: string
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
