import { useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { AssistantPanel } from '@/components/AssistantPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { Icon } from '@/components/Icon'
import { PageTransition } from '@/components/PageTransition'
import { Sidebar } from '@/components/Sidebar'
import { CreateDialog } from '@/components/CreateDialog'
import { RecordingBar } from '@/components/meeting/RecordingBar'
import { WorkspaceModal } from '@/components/WorkspaceModal'
import { call, useApi, useLiveData } from '@/lib/api'
import { AssistantProvider, useAssistant } from '@/lib/assistant'
import { ContextMenuProvider, useContextMenu } from '@/lib/contextMenu'
import { ToastProvider } from '@/lib/toast'
import { useDisplayPreferences } from '@/lib/display'
import { useTheme } from '@/lib/theme'
import { RecorderProvider } from '@/lib/recorder'
import { WorkspaceProvider, useWorkspaces } from '@/lib/workspace'
import { Onboarding } from '@/routes/Onboarding'
import { Welcome } from '@/routes/Welcome'
import { PeoplePage, PersonPage } from '@/routes/People'
import { ProjectToday } from '@/routes/project/ProjectToday'
import { ProjectKanban } from '@/routes/project/ProjectKanban'
import { ProjectLayout } from '@/routes/project/ProjectLayout'
import { ProjectMeetings } from '@/routes/project/ProjectMeetings'
import { MeetingWriter } from '@/routes/project/MeetingWriter'
import { ProjectSettings } from '@/routes/project/ProjectSettings'
import { ProjectDecisions, ProjectNotes, ProjectPeople } from '@/routes/project/ProjectNotes'
import { NoteWriter } from '@/routes/project/NoteWriter'
import { NewProjectModal, ProjectsPage } from '@/routes/Projects'
import { SettingsPage } from '@/routes/Settings'
import { WorkspaceSettings } from '@/routes/WorkspaceSettings'
import { TodayPage } from '@/routes/Today'

/**
 * What counts as "a different screen" for the purposes of the transition. A project's
 * own tabs are deliberately *not* separate screens — the heading above them does not
 * change, so re-animating the whole page every time you move between Kanban and Notes
 * would animate the parts that stayed still. Those tabs fade themselves in instead.
 */
function screenKey(pathname: string): string {
  const project = pathname.match(/^\/projects\/([^/]+)/)
  return project ? `project:${project[1]}` : pathname
}

function Shell(): React.JSX.Element {
  const { active, switchTo } = useWorkspaces()
  // Inside a project the target is already known, so it is never asked for.
  const inProject = useMatch('/projects/:id/*')
  const isBoard = Boolean(useMatch('/projects/:id/kanban'))
  // Writing is the one thing that owns the window: no heading above it, no search
  // bar, no reading width. Notes and meeting write-ups both do. See NoteWriter.
  //
  // Both matches are taken before they are combined, and deliberately so: `||` does
  // not evaluate its right-hand side once the left is true, and a `useMatch` skipped
  // on some renders and not others is a hook that changes position in the list.
  const inNote = useMatch('/projects/:id/notes/:noteId')
  const inMeeting = useMatch('/projects/:id/meetings/:meetingId')
  const writing = Boolean(inNote || inMeeting)
  const navigate = useNavigate()
  const location = useLocation()
  const scroller = useRef<HTMLElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  const assistant = useAssistant()
  // The preference lives in Settings; the shell only applies it. Same for how a date,
  // a clock and a temperature are written — applied here so every screen below agrees.
  useTheme()
  useDisplayPreferences()

  /**
   * The application menu drives the same actions the keyboard and buttons do, rather
   * than a parallel set of its own.
   */
  useEffect(() => {
    return window.api.onMenu((command) => {
      if (command.startsWith('go:')) navigate(command.slice(3))
      else if (command === 'new') setQuickAddOpen(true)
      else if (command === 'new-project') setNewProjectOpen(true)
      else if (command === 'new-workspace') setNewWorkspaceOpen(true)
      else if (command === 'search') setPaletteOpen(true)
      else if (command === 'assistant') assistant.toggle()
      else if (command === 'settings') navigate('/settings')
      else if (command === 'workspace-settings') navigate('/workspace')
      else if (command === 'back') history.back()
      else if (command === 'forward') history.forward()
    })
  }, [navigate, assistant])

  /**
   * Following a notification. It is the only way into the app that can name a
   * workspace other than the one on screen, so the workspace is switched first and
   * the path is followed after — arriving at a project in the wrong area would draw
   * a screen with nothing on it, which is exactly the failure workspace isolation
   * exists to prevent.
   */
  useEffect(() => {
    return window.api.onOpen(({ workspaceId, path }) => {
      if (workspaceId && workspaceId !== active?.id) switchTo(workspaceId)
      navigate(path)
    })
  }, [navigate, switchTo, active?.id])

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setPaletteOpen(true)
    } else if (meta && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      setQuickAddOpen(true)
    } else if (meta && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      assistant.toggle()
    }
  }, [assistant])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  return (
    <div className="glass-window flex h-full bg-base-100 text-base-content">
      <Sidebar />

      <div className="relative flex min-w-0 flex-1 flex-col">
        {!writing && (
          <header className="glass-chrome drag-region hairline flex h-[52px] shrink-0 items-center gap-3 border-b px-6">
            <button
              className="hairline flex h-8 w-full max-w-md items-center gap-2 rounded-field border bg-base-200/60 px-3 text-left text-[13px] text-base-content/40 transition hover:bg-base-200"
              onClick={() => setPaletteOpen(true)}
              title="Search everything (⌘K)"
            >
              <Icon name="search" size={14} />
              <span className="flex-1">Search everything…</span>
            </button>

            <button
              className={`btn btn-sm ml-auto gap-1.5 ${assistant.open ? 'btn-active' : 'btn-ghost'}`}
              onClick={assistant.toggle}
              title="Assistant (⌘J)"
              aria-pressed={assistant.open}
            >
              <Icon name="sparkle" size={14} className={assistant.open ? 'text-primary' : ''} />
              Assistant
            </button>

            <button
              className="btn btn-primary btn-sm gap-1.5"
              onClick={() => setQuickAddOpen(true)}
              title="New (⌘N)"
            >
              <Icon name="plus" size={14} />
              New
            </button>

            <AppMenu />
          </header>
        )}

        <main className={`glass-page min-h-0 flex-1 ${writing ? '' : 'scroll-area'}`} ref={scroller}>
          {/* A board should use the whole window; reading screens stay a comfortable width. */}
          <div
            className={
              writing ? 'h-full' : `mx-auto w-full px-8 py-8 ${isBoard ? 'max-w-none' : 'max-w-[1120px]'}`
            }
          >
            <PageTransition
              id={screenKey(location.pathname)}
              scrollRef={scroller}
              className={writing ? 'h-full' : ''}
            >
              <Routes location={location}>
                <Route path="/" element={<TodayPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:id" element={<ProjectLayout />}>
                  <Route index element={<ProjectToday />} />
                  <Route path="kanban" element={<ProjectKanban />} />
                  <Route path="meetings" element={<ProjectMeetings />} />
                  <Route path="notes" element={<ProjectNotes />} />
                  <Route path="decisions" element={<ProjectDecisions />} />
                  <Route path="people" element={<ProjectPeople />} />
                  <Route path="settings" element={<ProjectSettings />} />
                </Route>
                {/* Outside the project layout on purpose: the writers have no heading. */}
                <Route path="/projects/:id/notes/:noteId" element={<NoteWriter />} />
                <Route path="/projects/:id/meetings/:meetingId" element={<MeetingWriter />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/people/:id" element={<PersonPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/workspace" element={<WorkspaceSettings />} />
              </Routes>
            </PageTransition>
          </div>
        </main>

        {/*
          Outside the header on purpose. The header is not drawn on the writing screens
          — a note and a meeting write-up own the window — and the meeting write-up is
          exactly the screen you press record on, so a recording indicator that lived
          in the header would be invisible precisely where it is needed most.
        */}
        <RecordingBar />
      </div>

      <AssistantPanel />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <CreateDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        projectId={inProject?.params.id}
      />
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <WorkspaceModal
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        workspace={null}
        onSaved={(created) => {
          switchTo(created.id)
          navigate('/')
        }}
      />
    </div>
  )
}

/**
 * The app itself, rather than whatever is on screen — which is why it lives at the far
 * end of the header and not in the sidebar, where every other thing you can press is
 * about the workspace you are in. A workspace's own settings stay in the switcher at
 * the bottom of the sidebar, on the workspace they belong to, and a project's in that
 * project's own column.
 *
 * It hangs off the one menu system the whole app uses, so this says what is in the
 * list and nothing about where it goes or how it closes.
 */
function AppMenu(): React.JSX.Element {
  const openMenu = useContextMenu()
  const navigate = useNavigate()

  return (
    <button
      className="btn btn-ghost btn-sm -mr-2 px-2"
      title="More"
      aria-haspopup="menu"
      onClick={(e) =>
        openMenu(e, [
          {
            label: 'App settings',
            icon: 'settings',
            onSelect: () => navigate('/settings')
          }
        ])
      }
    >
      <Icon name="more" size={16} />
    </button>
  )
}

/**
 * Three ways in, and the difference between them is what the app is allowed to assume.
 *
 * A genuinely new install — nothing saved, not one workspace ever made — gets the
 * introduction: it has to say what this is before it asks for anything. Someone who
 * has been here for a year and has just deleted or archived their last workspace gets
 * the short screen instead; they do not need the pitch again, which is the whole
 * reason `onboardedAt` is written down rather than inferred from an empty database.
 *
 * The decision is latched on the first render that has the data, because finishing
 * the flow falsifies its own condition: the workspace it creates would unmount the
 * screen mid-save and let the app arrive behind it.
 */
function Gate(): React.JSX.Element {
  const { active, ready, workspaces, archived } = useWorkspaces()
  const settings = useApi('settings:get')
  const [firstRun, setFirstRun] = useState<boolean | null>(null)

  useEffect(() => {
    if (firstRun !== null || !ready || !settings.data) return
    setFirstRun(
      !settings.data.onboardedAt && workspaces.length === 0 && archived.length === 0
    )
  }, [firstRun, ready, settings.data, workspaces.length, archived.length])

  /*
   * The splash screen is still up until this is sent, and this is the earliest moment
   * it can honestly go: whichever of the three screens below is the right one, it is
   * now known and its data is here. Sent from a render effect rather than from main
   * guessing off `ready-to-show`, which fires on the pane above — empty, and still
   * waiting on its first query.
   */
  const settled = ready && firstRun !== null
  useEffect(() => {
    if (settled) void call('window:ready')
  }, [settled])

  if (!settled) return <div className="glass-window h-full bg-base-100" />
  return (
    <div className="app-enter h-full">
      {firstRun ? (
        <Welcome onDone={() => setFirstRun(false)} />
      ) : !active ? (
        <Onboarding />
      ) : (
        <AssistantProvider workspaceId={active.id}>
          <RecorderProvider>
            <Shell />
          </RecorderProvider>
        </AssistantProvider>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  // Writes the assistant and Claude Desktop make, which nothing here is waiting on.
  useLiveData()
  return (
    <HashRouter>
      <ToastProvider>
        <ContextMenuProvider>
          <WorkspaceProvider>
            <Gate />
          </WorkspaceProvider>
        </ContextMenuProvider>
      </ToastProvider>
    </HashRouter>
  )
}
