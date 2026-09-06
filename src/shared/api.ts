import type { SyncBilling, SyncStatus } from './sync'
import type {
  Activity, AttachmentUpload, BoardColumn, CastMember, ChatMessage, ContentFolder, Conversation,
  Decision, JournalEntry, Link, LinkKind, Membership, Note, Meeting, MeetingTodo, MeetingView, Person,
  PersonProject, Project, ProjectCollapsible, ProjectCollapsibleView, ProjectDetail, ProjectFolder,
  ProjectFolderView, ProjectStatus,
  ProjectSummary, Profile, RecordingView,
  SearchHit, Settings, Task, TaskKind, TaskStatus, TodayView, TranscriptCue, WeatherNow,
  WeatherPlace, Workspace, WorkspaceLink
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
  /**
   * The same picker for the photograph across the top of Today. Separate from
   * `icon:pick` because the two differ in every way that matters to the person
   * choosing: what the dialog is called, how big the file may be, and — since a
   * banner is served over `neo-media://` rather than inlined — what comes back.
   */
  'banner:pick': { in: void; out: { bannerPath: string; url: string } | null }

  /** The links on this workspace's front page, in the order they are drawn. */
  'workspaceLink:list': { in: Scope; out: WorkspaceLink[] }
  'workspaceLink:save': { in: Draft<WorkspaceLink>; out: WorkspaceLink }
  'workspaceLink:delete': { in: { id: string }; out: void }
  'workspaceLink:reorder': { in: { ids: string[] }; out: void }

  /**
   * The weather where this workspace is read, or null.
   *
   * The only channel in the app that leaves the machine without an API key, and the
   * only one whose failure is uninteresting: no network, no location, a service
   * having a bad day and a switched-off preference all come back the same way, and
   * Today simply does not draw that corner. It sends a latitude and a longitude and
   * nothing else — see `main/lib/weather.ts`.
   */
  'weather:get': { in: Scope; out: WeatherNow | null }
  /** Places matching a name, for choosing one in settings. Empty on any failure. */
  'weather:search': { in: { query: string }; out: WeatherPlace[] }

  'project:list': { in: ProjectFilter; out: ProjectSummary[] }
  'project:get': { in: { id: string; touch?: boolean }; out: ProjectDetail }
  'project:save': { in: Draft<Project>; out: Project }
  'project:setArchived': { in: { id: string; archived: boolean }; out: Project }
  'project:delete': { in: { id: string }; out: void }
  /**
   * Arrange the cards. The ids are one folder's worth of projects in the order they
   * are to be drawn — the whole visible set, not the one that moved, because a
   * position only means anything relative to its neighbours.
   */
  'project:reorder': { in: { ids: string[] }; out: void }

  /**
   * Every folder in the workspace, depth-first in the order they are shown, each
   * carrying its path and how many projects are filed directly in it. The whole tree
   * comes back in one call: there are tens of these, not thousands, and a page that
   * fetches a level at a time cannot draw the tree it needs to draw.
   */
  'folder:list': { in: Scope; out: ProjectFolderView[] }
  /**
   * Create or rename a folder, or move it under another one. Moving a folder inside
   * itself is refused rather than silently ignored — it would strand everything below
   * it.
   */
  'folder:save': { in: Draft<ProjectFolder>; out: ProjectFolder }
  /**
   * Delete the folder itself and nothing else. Its subfolders and its projects move
   * up to where it was, so unfiling is never a way to lose work. There is nothing to
   * confirm because there is nothing to lose.
   */
  'folder:delete': { in: { id: string }; out: void }
  /** Order the folders that share a parent. */
  'folder:reorder': { in: { ids: string[] }; out: void }

  /**
   * Every collapsible in the workspace, each carrying the level it is drawn at and how
   * many projects are in it. Flat and unnested on purpose: a collapsible holds project
   * cards and never another collapsible — a band you have to open to find another band
   * is a folder, and folders are already here.
   */
  'collapsible:list': { in: Scope; out: ProjectCollapsibleView[] }
  /**
   * Create one, rename it, or fold it shut. The level it sits at is fixed when it is
   * made: every project in it is at that level too, so moving the band would strand
   * its cards on a page it is no longer drawn on.
   */
  'collapsible:save': { in: Draft<ProjectCollapsible>; out: ProjectCollapsible }
  /**
   * Delete the band and nothing else. Its projects come back up to the loose cards
   * above it, so ungrouping is never a way to lose work.
   */
  'collapsible:delete': { in: { id: string }; out: void }


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

  /**
   * `projectId` narrows the list to that project's cast. Assigning work is the reason
   * this is here: an item belongs to one project, so the people who can own it are the
   * people on that project, not everyone in the workspace.
   */
  'person:list': {
    in: Scope & { query?: string; projectId?: string }
    out: (Person & { projectCount: number })[]
  }
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

  /*
   * ------------------------------------------------- filing notes and meetings
   *
   * The project-scoped twin of `folder:*`, serving both lists through one `kind`.
   * There is no `contentFolder:list`: a project's folders come back with the project
   * itself, on `ProjectDetail`, because that is the one call every screen that draws
   * them has already made.
   */

  /**
   * Create or rename one, or move it under another. Moving a folder inside its own
   * branch is refused rather than silently ignored — it would strand everything below
   * it — and so is moving one between projects or between the two lists, which would
   * leave what is filed in it on a page that can no longer draw it.
   */
  'contentFolder:save': { in: Draft<ContentFolder>; out: ContentFolder }
  /**
   * Delete the folder itself and nothing else. Its subfolders and whatever is filed in
   * it move up to where it was, so unfiling is never a way to lose a note or a
   * meeting. There is nothing to confirm because there is nothing to lose.
   */
  'contentFolder:delete': { in: { id: string }; out: void }

  'meeting:save': { in: Draft<Meeting> & { attendeeIds?: string[] }; out: MeetingView }
  /**
   * A name for this meeting, worked out from what is in it — the write-up, and the
   * transcript too if it was recorded. It only *suggests*: nothing is written, so the
   * name lands in the field where it can be read and edited before it is kept. Runs
   * on whichever engine the workspace uses for recaps, local one included.
   */
  'meeting:suggestName': { in: { id: string }; out: { title: string } }
  'meeting:delete': { in: { id: string }; out: void }

  /** Add or edit one of a meeting's to-do items. Returns the meeting it belongs to. */
  'meetingTodo:save': { in: Draft<MeetingTodo>; out: MeetingView }
  'meetingTodo:delete': { in: { id: string }; out: void }
  /**
   * Put an item on the board: it gains a card in the first column (or the one named)
   * and stops answering for itself. Taking it off again is `meetingTodo:save` with a
   * null `taskId` — the card stays where it is, the item simply stops pointing at it.
   */
  'meetingTodo:promote': { in: { id: string; columnId?: string }; out: MeetingView }

  /* ---------------------------------------------------------------- recording */

  /**
   * Begin recording this meeting, or hand back the one already in progress. The
   * microphone itself stays in the renderer — only a renderer can open one — so what
   * this does is create the row and the folder the bytes will land in.
   */
  'recording:start': { in: { meetingId: string }; out: RecordingView }
  /**
   * Pick a capture back up after it was interrupted. The audio already on disk is
   * kept and the new sound is appended as further segments, so a meeting that
   * outlived a flat battery is still one recording.
   */
  'recording:resume': { in: { id: string }; out: RecordingView }
  /** Claim the next file to write into. Called at the start and every five minutes. */
  'recording:openSegment': { in: { id: string }; out: { segmentId: string; ord: number } }
  /**
   * A second of audio, base64 encoded, appended to the segment's file and flushed
   * before this resolves. Everything that has resolved is on disk: that is the whole
   * durability guarantee, and it is why the renderer awaits each one.
   */
  'recording:appendChunk': { in: { segmentId: string; data: string }; out: { bytes: number } }
  /** No more audio is coming for this segment. Fixes its duration on the timeline. */
  'recording:closeSegment': { in: { segmentId: string; durationMs: number }; out: void }
  /**
   * Still recording. A row whose heartbeat has gone quiet was being written by a
   * renderer that is no longer there, and main marks it interrupted on its own.
   */
  'recording:heartbeat': { in: { id: string; durationMs: number }; out: void }
  /**
   * The meeting is over. Capture closes and the pipeline takes it from there by
   * itself — transcribing, attributing speakers, and then writing the recap.
   */
  'recording:stop': { in: { id: string; durationMs: number }; out: RecordingView }

  /** The recording and its words. The cues are not on `MeetingView`: they are long. */
  'recording:get': {
    in: { meetingId: string }
    out: { recording: RecordingView | null; cues: TranscriptCue[] }
  }
  /** Have another go at a step that gave up. */
  'recording:retry': { in: { id: string; step: 'transcript' | 'speakers' | 'summary' }; out: RecordingView }
  /**
   * Throw the audio away and keep every word of it. The transcript and the recap are
   * what you read afterwards; the audio is what takes the disk space.
   */
  'recording:deleteAudio': { in: { id: string }; out: RecordingView }
  /** The recording, its audio, its transcript and its recap. The meeting stays. */
  'recording:delete': { in: { id: string }; out: void }
  /** Put a name to "Speaker 2" once, and every line it said says it. */
  'recording:nameSpeaker': {
    in: { id: string; label: string; name: string; personId?: string | null }
    out: RecordingView
  }
  /**
   * Fold a finished recap into the meeting itself: the write-up gains it as ordinary
   * Markdown, an untitled meeting gains a name, and every commitment becomes one of
   * the meeting's to-do items. Called by the pipeline the moment the recap is
   * written, and idempotent — it happens once, and after that the write-up is yours.
   */
  'recording:applyRecap': { in: { id: string }; out: MeetingView }
  /**
   * Ask macOS for the microphone, which it will only grant in answer to a real
   * request from the application rather than from a web page inside it.
   */
  'recording:requestMic': { in: void; out: { granted: boolean } }
  /**
   * Start listening to what the computer itself is playing — the other half of a
   * video call — and stream it to this window to be mixed with the microphone.
   *
   * Never throws. Not capturing the computer's sound is something a recording is
   * expected to survive, so a refusal comes back as `ok: false` and a sentence
   * saying why, and the recording goes ahead with the microphone alone.
   */
  'systemAudio:start': { in: void; out: import('./recording').SystemAudioStart }
  'systemAudio:stop': { in: void; out: void }
  /** Whether this machine and this build could do it at all, before anything is asked. */
  'systemAudio:available': { in: void; out: { available: boolean } }
  /**
   * Try it for a couple of seconds and say what happened, byte count included.
   *
   * macOS decides all of this at the moment it is first asked, and offers no way to
   * ask beforehand — so the only honest answer is to try. The bytes are the part that
   * matters: a tap that opened and produced silence is the failure you would
   * otherwise find at the end of a meeting.
   */
  'systemAudio:test': {
    in: void
    out: { ok: boolean; reason: string; bytes: number; sampleRate: number }
  }

  'decision:save': { in: Draft<Decision>; out: Decision }
  'decision:delete': { in: { id: string }; out: void }

  'link:save': { in: Draft<Link> & { kind?: LinkKind }; out: Link }
  'link:delete': { in: { id: string }; out: void }

  'journal:save': { in: Draft<JournalEntry>; out: JournalEntry }
  'journal:delete': { in: { id: string }; out: void }

  'dashboard:today': { in: Scope; out: TodayView }
  'dashboard:activity': { in: Scope & { limit?: number }; out: (Activity & { projectName: string; workspaceColor: string })[] }

  'search:query': { in: Scope & { q: string }; out: SearchHit[] }

  /**
   * What this workspace would say out loud this morning, given what it is set to say.
   *
   * Derived on every call and stored nowhere, like the attention line: the deadlines
   * and the due dates are the only inputs, so there is no reminder to create, snooze
   * or tidy up after. Empty is the ordinary answer on an ordinary day.
   *
   * The delivery loop reads it, and so does the settings pane — which is the point of
   * it being a channel rather than something the loop works out privately. A screen
   * that can show you the sentence you have just configured is worth more than any
   * amount of prose explaining what the switches do.
   */
  'notification:pending': { in: Scope; out: import('./types').PendingNotification[] }
  /**
   * Put one on the desktop now, whatever the settings say and without writing down
   * that it happened.
   *
   * macOS decides whether an application may show notifications at the moment it
   * first tries, and offers no way to ask beforehand — so, exactly as with the audio
   * tap, the only honest way to answer "will this work" is to do it, and this is also
   * what makes the operating system put its own question on screen. What comes back
   * is what actually happened rather than that it was attempted: the failure arrives
   * on an event a moment later, not as a thrown error, which is why an earlier version
   * of this reported success while nothing appeared.
   *
   * A refusal and a prompt still waiting for an answer are indistinguishable from
   * here — both are "not allowed, yet" — so `reason` says so rather than guessing.
   */
  'notification:test': { in: void; out: { shown: boolean; reason: string } }
  /**
   * What this machine can do about notifications at all, before anything is shown.
   *
   * `gated` is the interesting one: it says the operating system will not let an
   * application show a notification until the person has agreed to it, which is true
   * of macOS and not of Windows or Linux. It is what decides whether the first-run
   * flow has a panel about notifications in it — asking somewhere that never asks
   * would be a step that does nothing.
   */
  'notification:capability': { in: void; out: { supported: boolean; gated: boolean } }

  'profile:get': { in: void; out: Profile }
  'profile:save': { in: Partial<Profile>; out: Profile }
  /** What to put in the name field on first run, from the machine's own account. */
  'profile:suggestName': { in: void; out: { name: string } }

  'sync:status': { in: void; out: SyncStatus }
  'sync:signIn': { in: { serverUrl: string }; out: { connected: boolean; handle: string } }
  'sync:unlock': { in: { passphrase: string }; out: { ok: boolean; reason: string } }
  'sync:nudge': { in: void; out: { show: boolean } }
  'sync:dismissNudge': { in: void; out: { show: boolean } }
  'sync:now': { in: void; out: SyncStatus }
  'sync:disconnect': { in: void; out: SyncStatus }
  /** What the plans cost, which is the only thing the server has to ask Stripe. */
  'sync:prices': { in: void; out: SyncBilling }
  /** Opens Stripe in the real browser and answers whether it went. */
  'sync:pay': { in: { kind: 'monthly' | 'yearly' | 'manage' }; out: { opened: boolean } }

  'settings:get': { in: void; out: Settings }
  'settings:save': { in: Partial<Settings>; out: Settings }
  'settings:revealData': { in: void; out: void }
  'settings:exportMarkdown': { in: void; out: { files: number; dir: string } }
  'settings:exportJson': { in: void; out: { path: string } }
  'settings:loadSample': { in: void; out: void }
  'settings:wipe': { in: void; out: void }

  'shell:openExternal': { in: { url: string }; out: void }

  /* ------------------------------------------------------------------- updating */

  /**
   * Where the update stands, as of now. Cheap, and safe to ask for on every render:
   * it reports what the runner already knows and never goes near the network.
   *
   * Progress arrives on the `update` event rather than by polling this, for the same
   * reason a recording's does — it runs whether or not anything is on screen.
   */
  'update:status': { in: void; out: import('./update').UpdateStatus }
  /**
   * Look now, whatever the preference says and whatever the timer was going to do.
   * This is the only path that will ask GitHub while updates are switched off — off
   * means the app never does it on its own, not that the button is a lie.
   */
  'update:check': { in: void; out: import('./update').UpdateStatus }
  /** Fetch the waiting release and park it. Only meaningful once one is available. */
  'update:download': { in: void; out: import('./update').UpdateStatus }
  /**
   * Close and come back on the new version. Quitting is what applies it; there is no
   * other way in, because replacing an application somebody is using is not a thing
   * to do politely. False when there was nothing staged to apply.
   */
  'update:restart': { in: void; out: { restarting: boolean } }
  /**
   * Whether this copy can replace itself, and whether doing so will make macOS
   * forget its privacy permissions. Read from the bundle's own signature — see
   * `lib/updater.ts` — so a real Developer ID retires the permissions panel by itself.
   */
  'update:capability': { in: void; out: import('./update').UpdateCapability }

  /**
   * What changed, bundled with the app rather than fetched.
   *
   * Without a version it is the whole history, newest first — the Updates pane. With
   * one it is that release alone, which is what the screen after an update draws, and
   * null when that version shipped without writing anything down.
   */
  'changelog:list': { in: void; out: import('./update').ChangelogEntry[] }
  'changelog:get': { in: { version: string }; out: import('./update').ChangelogEntry | null }

  /**
   * The three permissions an ad-hoc signed update costs, and the only honest way to
   * get them back: asking for each one for real. Two of the three cannot be read
   * without asking — macOS has no API for either — so `read` reports `unknown` rather
   * than guessing, and pressing the button *is* the question.
   */
  'permission:read': { in: void; out: import('./update').PermissionReport[] }
  'permission:ask': {
    in: { name: import('./update').PermissionName }
    out: import('./update').PermissionReport
  }

  /**
   * Turn the window itself into glass, or take it back.
   *
   * Only an operating system can blur what is *behind* an application — a page's own
   * `backdrop-filter` cannot see the desktop — so this is main's half of the Liquid
   * Glass theme, and the half that can fail. macOS gets a vibrancy view under the
   * web contents and Windows 11 an acrylic backdrop; anywhere else there is nothing
   * to ask for. Only whether, never how much: the macOS material is fixed for the life
   * of a window — see `lib/glass.ts` — so the amount is the renderer's paint alone. What comes back is what was actually got, never what was asked for:
   * `window` means the desktop is showing through, `paint` means it is not and the
   * renderer draws its own backdrop for the glass to sit on.
   */
  'window:glass': {
    in: { on: boolean }
    out: { material: 'window' | 'paint' }
  }
  /**
   * "There is something real on screen." Sent once, on the first render that has its
   * data — which is the moment the splash screen can go and the window it has been
   * standing in for can be revealed.
   *
   * It is the renderer that says so rather than main working it out, because only the
   * renderer knows: `ready-to-show` fires on an empty shell that is still waiting for
   * its first query, and handing over there would trade a splash for a blank pane.
   * Saying it twice is harmless — a reload in development arrives long after the
   * splash has gone, and the hand-off is idempotent.
   */
  'window:ready': { in: void; out: void }

  /* -------------------------------------------------------- the Claude connector */

  /** Where the Claude Desktop connector stands: installed, connected, or neither. */
  'mcp:status': { in: void; out: import('./mcp').McpStatus }
  /**
   * Add Neo to Claude Desktop's own list of servers, leaving everything else in that
   * file alone. Claude Desktop has to be restarted before it reads it.
   */
  'mcp:connect': { in: void; out: import('./mcp').McpStatus }
  /** Take Neo back out of it again. */
  'mcp:disconnect': { in: void; out: import('./mcp').McpStatus }
  /** Show Claude Desktop's configuration file in the Finder, for setting it up by hand. */
  'mcp:revealConfig': { in: void; out: void }

  /* ---------------------------------------------------------------- assistant */

  'chat:list': { in: Scope; out: Conversation[] }
  /** A conversation with its turns, oldest first. */
  'chat:get': { in: { id: string }; out: { conversation: Conversation; messages: ChatMessage[] } }
  'chat:rename': { in: { id: string; title: string }; out: Conversation }
  'chat:delete': { in: { id: string }; out: void }
  /**
   * Ask. Returns as soon as the run has started — the reply itself arrives on the
   * `ai` event channel, a token at a time, so it can be read while it is written.
   * Without `conversationId` a new conversation is opened and named after the first
   * exchange. `runId` is what `chat:respond` and `chat:cancel` refer to.
   */
  'chat:send': {
    in: {
      workspaceId: string
      conversationId?: string
      text: string
      files?: AttachmentUpload[]
      /** The project the panel was opened over, so "this project" has a referent. */
      projectId?: string
    }
    /** `messageId` is the user's turn as saved, so the panel knows when to stop
     *  drawing its optimistic copy of it. */
    out: { runId: string; conversationId: string; messageId: string }
  }
  /** Answer the confirmation a write tool is waiting on. */
  'chat:respond': { in: { runId: string; toolUseId: string; approved: boolean }; out: void }
  'chat:cancel': { in: { runId: string }; out: void }
  /** Write-only: the key goes in and never comes back out. Empty string clears it. */
  'chat:setKey': { in: { workspaceId: string; apiKey: string }; out: Workspace }
}

export type Channel = keyof ApiMap
export type Input<C extends Channel> = ApiMap[C]['in']
export type Output<C extends Channel> = ApiMap[C]['out']

export type { ProjectStatus, TaskKind, TaskStatus }
