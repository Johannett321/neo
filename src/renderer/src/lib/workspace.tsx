import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
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
        ready: workspaces.isSuccess && settings.isSuccess,
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
