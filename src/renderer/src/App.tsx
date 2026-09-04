import { useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { CommandPalette } from '@/components/CommandPalette'
import { Icon } from '@/components/Icon'
import { PageTransition } from '@/components/PageTransition'
import { Sidebar } from '@/components/Sidebar'
import { CreateDialog } from '@/components/CreateDialog'
import { WorkspaceModal } from '@/components/WorkspaceModal'
import { ContextMenuProvider } from '@/lib/contextMenu'
import { ToastProvider } from '@/lib/toast'
import { useTheme } from '@/lib/theme'
import { WorkspaceProvider, useWorkspaces } from '@/lib/workspace'
import { Onboarding } from '@/routes/Onboarding'
import { PeoplePage, PersonPage } from '@/routes/People'
import { ProjectToday } from '@/routes/project/ProjectToday'
import { ProjectKanban } from '@/routes/project/ProjectKanban'
import { ProjectLayout } from '@/routes/project/ProjectLayout'
import { ProjectMeetings } from '@/routes/project/ProjectMeetings'
import { ProjectSettings } from '@/routes/project/ProjectSettings'
import { ProjectDecisions, ProjectNotes, ProjectPeople } from '@/routes/project/ProjectNotes'
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
  const { active, ready, switchTo } = useWorkspaces()
  // Inside a project the target is already known, so it is never asked for.
  const inProject = useMatch('/projects/:id/*')
  const isBoard = Boolean(useMatch('/projects/:id/kanban'))
  const navigate = useNavigate()
  const location = useLocation()
  const scroller = useRef<HTMLElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  // The preference lives in Settings; the shell only applies it.
  useTheme()

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
      else if (command === 'settings') navigate('/settings')
      else if (command === 'workspace-settings') navigate('/workspace')
      else if (command === 'back') history.back()
      else if (command === 'forward') history.forward()
    })
  }, [navigate])

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setPaletteOpen(true)
    } else if (meta && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      setQuickAddOpen(true)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  if (!ready) return <div className="h-full bg-base-100" />
  // Nothing to show until there is a workspace to be inside.
  if (!active) return <Onboarding />

  return (
    <div className="flex h-full bg-base-100 text-base-content">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region hairline flex h-[52px] shrink-0 items-center gap-3 border-b px-6">
          <button
            className="hairline flex h-8 w-full max-w-md items-center gap-2 rounded-field border bg-base-200/60 px-3 text-left text-[13px] text-base-content/40 transition hover:bg-base-200"
            onClick={() => setPaletteOpen(true)}
            title="Search everything (⌘K)"
          >
            <Icon name="search" size={14} />
            <span className="flex-1">Search everything…</span>
          </button>

          <button
            className="btn btn-primary btn-sm ml-auto gap-1.5"
            onClick={() => setQuickAddOpen(true)}
            title="New (⌘N)"
          >
            <Icon name="plus" size={14} />
            New
          </button>
        </header>

        <main className="scroll-area flex-1" ref={scroller}>
          {/* A board should use the whole window; reading screens stay a comfortable width. */}
          <div className={`mx-auto w-full px-8 py-8 ${isBoard ? 'max-w-none' : 'max-w-[1120px]'}`}>
            <PageTransition id={screenKey(location.pathname)} scrollRef={scroller}>
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
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/people/:id" element={<PersonPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/workspace" element={<WorkspaceSettings />} />
              </Routes>
            </PageTransition>
          </div>
        </main>
      </div>

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

export default function App(): React.JSX.Element {
  return (
    <HashRouter>
      <ToastProvider>
        <ContextMenuProvider>
          <WorkspaceProvider>
            <Shell />
          </WorkspaceProvider>
        </ContextMenuProvider>
      </ToastProvider>
    </HashRouter>
  )
}
