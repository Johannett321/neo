import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, type NavigateOptions } from 'react-router-dom'
import type { Workspace } from '@shared/types'
import { useApi, useApiMutation } from './api'

interface WorkspaceState {
  /** Live workspaces only — archived ones never appear in normal navigation. */
  workspaces: Workspace[]
  archived: Workspace[]
  active: Workspace | null
  ready: boolean
  switchTo: (id: string) => void
}

const WorkspaceContext = createContext<WorkspaceState | null>(null)

/**
 * A workspace is a separate area, so the active one is ambient state rather than
 * a filter: every screen reads it and every scoped request carries it. The choice
 * is persisted, so the app reopens where you left it.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const workspaces = useApi('workspace:list')
  const settings = useApi('settings:get')
  const saveSettings = useApiMutation('settings:save')
  const [selected, setSelected] = useState<string | null>(null)

  const remembered = settings.data?.activeWorkspaceId
  useEffect(() => {
    if (!selected && remembered) setSelected(remembered)
  }, [remembered, selected])

  const all = workspaces.data ?? []
  const list = all.filter((w) => !w.archivedAt)
  const archived = all.filter((w) => w.archivedAt)
  // A remembered workspace can be deleted or archived from under us; fall back.
  const active = list.find((w) => w.id === selected) ?? list[0] ?? null

  const switchTo = (id: string): void => {
    setSelected(id)
    saveSettings.mutate({ activeWorkspaceId: id })
  }

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces: list,
        archived,
        active,
        // Having the answers, not having just fetched them: offline, the copy kept on
        // this Mac is the answer, and a refetch that failed does not take it away.
        ready: workspaces.data !== undefined && settings.data !== undefined,
        switchTo
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspaces(): WorkspaceState {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspaces used outside WorkspaceProvider')
  return value
}

/** The active workspace. Only valid inside the shell, which never renders without one. */
export function useWorkspace(): Workspace {
  const { active } = useWorkspaces()
  if (!active) throw new Error('useWorkspace used with no active workspace')
  return active
}

/**
 * Go to something that lives in a workspace, switching to that workspace first when it
 * is not the one on screen.
 *
 * Every screen but one is fenced to the active workspace, so a link on it can never
 * lead out of it. The overview across workspaces is the exception, and a row there that
 * opened its project without switching would draw that project inside the wrong
 * workspace — the sidebar, the people, the search all answering for somewhere else.
 * Switching and navigating in the same tick lands both in one render. On a fenced screen
 * the workspace is already the right one, so this is an ordinary `navigate`.
 */
export function useGoIn(): (workspaceId: string, path: string, options?: NavigateOptions) => void {
  const { active, switchTo } = useWorkspaces()
  const navigate = useNavigate()
  const activeId = active?.id
  return useCallback(
    (workspaceId: string, path: string, options?: NavigateOptions) => {
      if (workspaceId && workspaceId !== activeId) switchTo(workspaceId)
      navigate(path, options)
    },
    [activeId, switchTo, navigate]
  )
}
