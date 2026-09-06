import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ProjectFolderView } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { branchIds, childrenOf, crumbsOf, recallFolder, rememberFolder } from '@/lib/folders'
import { differs, plural } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { EmptyState, Field, Modal, PageHeader } from '@/components/primitives'
import { IconPicker } from '@/components/IconPicker'
import { ProjectCard } from '@/components/ProjectCard'
import { MoveToFolderModal, NewFolderModal } from '@/components/FolderPicker'
import {
  DraggableCard, FolderBreadcrumbs, FolderCard, type Dragged
} from '@/components/ProjectFolders'

export function ProjectsPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newFolderIn, setNewFolderIn] = useState<string | null | undefined>(undefined)
  const [movingFolder, setMovingFolder] = useState<ProjectFolderView | null>(null)
  const [dragged, setDragged] = useState<Dragged | null>(null)

  /*
   * Which folder is open lives in the URL, so the back button walks back up the way it
   * does in a file browser and a reload lands you where you were. The workspace is
   * ambient state; a folder is not — it is somewhere you navigated to.
   */
  const [params, setParams] = useSearchParams()
  const saveProject = useApiMutation('project:save')
  const saveFolder = useApiMutation('folder:save')

  // "Active" simply means not archived — the finer statuses are shown on the cards
  // rather than being another thing to filter by.
  const projects = useApi('project:list', {
    workspaceId: workspace.id,
    status: 'all',
    archived: showArchived
  })
  const archived = useApi('project:list', { workspaceId: workspace.id, status: 'all', archived: true })
  const folderList = useApi('folder:list', { workspaceId: workspace.id })
  const list = projects.data ?? []
  const folders = folderList.data ?? []
  const archivedCount = archived.data?.length ?? 0

  /*
   * The archive is one flat list on purpose. It is where you go to find the one thing
   * you put away, so it shows everything archived at once rather than asking you to
   * remember which folder it was in on the day you archived it.
   */
  const crumbs = showArchived ? [] : crumbsOf(folders, params.get('in'))
  // A folder can go while you are standing in it — from the assistant, from Claude
  // Desktop, from a menu. Reading the open folder back off the trail rather than off
  // the URL is what turns that into "you are at the top level" instead of a blank page.
  const openFolderId = crumbs.length > 0 ? crumbs[crumbs.length - 1].id : null
  const open = (folderId: string | null): void => {
    rememberFolder(workspace.id, folderId)
    setParams(folderId ? { in: folderId } : {})
  }

  /*
   * Arriving with no folder in the URL — from the sidebar, or from the way out of a
   * project — puts you back in the folder you were last in. Once only, on the way in:
   * after that, going up to the top level is a decision, and re-restoring the folder
   * you just left would be the page arguing with you.
   */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const remembered = recallFolder(workspace.id)
    if (remembered && !params.get('in')) setParams({ in: remembered }, { replace: true })
  }, [workspace.id, params, setParams])

  const subfolders = showArchived ? [] : childrenOf(folders, openFolderId)
  const visible = showArchived ? list : list.filter((p) => (p.folderId ?? null) === openFolderId)

  const moveHere = (item: Dragged, folderId: string | null): void => {
    if (item.kind === 'project') saveProject.mutate({ id: item.id, folderId })
    else if (item.id !== folderId) saveFolder.mutate({ id: item.id, parentId: folderId })
    setDragged(null)
  }

  return (
    <>
      <PageHeader
        title={openFolderId ? crumbs[crumbs.length - 1].name : 'Projects'}
        subtitle={
          projects.data ? (
            <span className="flex items-center gap-3">
              {/* Only ever drawn once you are inside something. With no folders there is
                  no trail, and the page is exactly what it has always been. */}
              {crumbs.length > 0 ? (
                <FolderBreadcrumbs
                  crumbs={crumbs}
                  folders={folders}
                  dragged={dragged}
                  onOpen={open}
                  onMoveHere={moveHere}
                />
              ) : (
                <span>
                  {plural(list.length, showArchived ? 'archived project' : 'project')} in{' '}
                  {workspace.name}
                </span>
              )}
              {(archivedCount > 0 || showArchived) && (
                <button
                  className="shrink-0 text-base-content/45 underline decoration-base-content/20 underline-offset-2 transition hover:text-base-content hover:decoration-current"
                  onClick={() => {
                    setShowArchived((v) => !v)
                    open(null)
                  }}
                >
                  {showArchived ? 'Back to active' : `Archived (${archivedCount})`}
                </button>
              )}
            </span>
          ) : (
            ' '
          )
        }
        actions={
          <>
            {!showArchived && (
              <button
                className="btn btn-ghost btn-sm gap-1.5"
                onClick={() => setNewFolderIn(openFolderId)}
              >
                <Icon name="folder" size={14} />
                New folder
              </button>
            )}
            <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              New project
            </button>
          </>
        }
      />

      {visible.length === 0 && subfolders.length === 0 ? (
        <EmptyState
          icon={showArchived ? 'archive' : openFolderId ? 'folder' : 'projects'}
          title={
            showArchived
              ? 'Nothing archived.'
              : openFolderId
                ? 'Nothing in this folder yet.'
                : 'No projects here yet.'
          }
          hint={
            showArchived
              ? 'Archiving a project puts it out of the way without deleting anything.'
              : openFolderId
                ? 'Drag a project card onto a folder to file it, or start one in here.'
                : "A project is anything you would otherwise have to hold in your head: a team's workstream, a client engagement, a side of the business."
          }
          action={
            !showArchived && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                {openFolderId ? 'New project here' : 'Create one'}
              </button>
            )
          }
        />
      ) : (
        <>
          {/* Folders first, in a row of their own. A folder is not work, so it does not
              sit among the work as another card the same size. */}
          {subfolders.length > 0 && (
            <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {subfolders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  folders={folders}
                  dragged={dragged}
                  onOpen={() => open(folder.id)}
                  onDragged={setDragged}
                  onMoveHere={moveHere}
                  onNewSubfolder={() => setNewFolderIn(folder.id)}
                  onMove={() => setMovingFolder(folder)}
                />
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((project) =>
              showArchived ? (
                <ProjectCard key={project.id} project={project} />
              ) : (
                <DraggableCard key={project.id} project={project} onDragged={setDragged} />
              )
            )}
          </div>
        </>
      )}

      {/* Keyed on the folder, so a project started inside one is created inside it. */}
      <NewProjectModal
        key={openFolderId ?? 'root'}
        open={creating}
        onClose={() => setCreating(false)}
        folderId={openFolderId}
      />

      {newFolderIn !== undefined && (
        <NewFolderModal
          key={newFolderIn ?? 'root'}
          open
          onClose={() => setNewFolderIn(undefined)}
          workspaceId={workspace.id}
          folders={folders}
          parentId={newFolderIn}
        />
      )}

      {movingFolder && (
        <MoveToFolderModal
          key={movingFolder.id}
          open
          onClose={() => setMovingFolder(null)}
          folders={folders}
          title={`Move ${movingFolder.name}`}
          description="Everything filed inside it comes along."
          current={movingFolder.parentId}
          // Into itself, or into one of its own children: the branch would still be
          // there and nothing would ever draw it again.
          exclude={branchIds(folders, movingFolder.id)}
          onMove={(parentId) => saveFolder.mutate({ id: movingFolder.id, parentId })}
        />
      )}
    </>
  )
}

export function NewProjectModal({
  open,
  onClose,
  folderId = null
}: {
  open: boolean
  onClose: () => void
  /** Where it lands: the folder you were standing in when you pressed New project. */
  folderId?: string | null
}): React.JSX.Element {
  const workspace = useWorkspace()
  const save = useApiMutation('project:save')
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [iconPath, setIconPath] = useState('')
  const [iconPreview, setIconPreview] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    await save.mutateAsync({
      name: name.trim(),
      summary,
      iconPath,
      folderId,
      workspaceId: workspace.id,
      status: 'active'
    })
    setName('')
    setSummary('')
    setIconPath('')
    setIconPreview(null)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description={`It will live in ${workspace.name}.`}
      onSubmit={() => void submit()}
      isDirty={differs({ name, summary, iconPath }, { name: '', summary: '', iconPath: '' })}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => void submit()}>
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <IconPicker
          name={name}
          color={workspace.color}
          icon={iconPreview}
          size={44}
          hint="Optional. Without one the project shows its initial."
          onChange={({ iconPath: next, icon }) => {
            setIconPath(next)
            setIconPreview(icon)
          }}
        />
        <Field label="Name">
          <input
            autoFocus
            className="input input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="One line about it">
          <input
            className="input input-bordered w-full"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
