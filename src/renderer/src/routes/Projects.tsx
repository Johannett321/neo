import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ProjectFolderView } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { branchIds, childrenOf, crumbsOf, recallFolder, rememberFolder } from '@/lib/folders'
import { differs, plural } from '@/lib/format'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { Icon } from '@/components/Icon'
import { EmptyState, Field, Modal, PageHeader } from '@/components/primitives'
import { IconPicker } from '@/components/IconPicker'
import { ProjectCard } from '@/components/ProjectCard'
import { MoveToFolderModal, NewFolderModal } from '@/components/FolderPicker'
import { CollapsibleSection, LooseArea } from '@/components/ProjectCollapsibles'
import { FolderBreadcrumbs, FolderCard, type Dragged } from '@/components/ProjectFolders'
import { ProjectGrid } from '@/components/ProjectGrid'

export function ProjectsPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newFolderIn, setNewFolderIn] = useState<string | null | undefined>(undefined)
  const [movingFolder, setMovingFolder] = useState<ProjectFolderView | null>(null)
  const [dragged, setDragged] = useState<Dragged | null>(null)
  /*
   * A collapsible is made with its name already selected, the way a new folder is in a
   * file browser: the row exists the moment you ask for it and typing over the name is
   * the next thing you do. This is the id of the one waiting to be named — a latch, so
   * that the band stops asking as soon as it has been answered once.
   */
  const [naming, setNaming] = useState<string | null>(null)
  /** Which collapsible a new project should land in, when one was asked for from a band. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null)

  /*
   * Which folder is open lives in the URL, so the back button walks back up the way it
   * does in a file browser and a reload lands you where you were. The workspace is
   * ambient state; a folder is not — it is somewhere you navigated to.
   */
  const [params, setParams] = useSearchParams()
  const openMenu = useContextMenu()
  const saveProject = useApiMutation('project:save')
  const saveFolder = useApiMutation('folder:save')
  const saveCollapsible = useApiMutation('collapsible:save')

  // "Active" simply means not archived — the finer statuses are shown on the cards
  // rather than being another thing to filter by.
  const projects = useApi('project:list', {
    workspaceId: workspace.id,
    status: 'all',
    archived: showArchived
  })
  const archived = useApi('project:list', { workspaceId: workspace.id, status: 'all', archived: true })
  const folderList = useApi('folder:list', { workspaceId: workspace.id })
  const collapsibleList = useApi('collapsible:list', { workspaceId: workspace.id })
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

  /*
   * The bands drawn on this page: the ones made at this level, and never any others.
   * A collapsible sits at one level and holds only projects filed at that level, so
   * walking into a folder is walking away from the bands outside it as completely as
   * it is walking away from the cards.
   */
  const bands = showArchived
    ? []
    : (collapsibleList.data ?? []).filter((c) => (c.folderId ?? null) === openFolderId)
  const banded = new Set(bands.map((c) => c.id))
  // Anything whose band is not on this page is loose here, which is what stops a row
  // arriving from somewhere unexpected from vanishing off the screen entirely.
  const loose = visible.filter((p) => !p.collapsibleId || !banded.has(p.collapsibleId))
  const carried =
    dragged?.kind === 'project' ? (visible.find((p) => p.id === dragged.id) ?? null) : null

  const moveHere = (item: Dragged, folderId: string | null): void => {
    if (item.kind === 'project') saveProject.mutate({ id: item.id, folderId })
    else if (item.id !== folderId) saveFolder.mutate({ id: item.id, parentId: folderId })
    setDragged(null)
  }

  /** Into a band, or back out of one. The same write either way. */
  const groupHere = (projectId: string, collapsibleId: string | null): void => {
    saveProject.mutate({ id: projectId, collapsibleId })
    setDragged(null)
  }

  const newCollapsible = async (): Promise<void> => {
    const made = await saveCollapsible.mutateAsync({
      workspaceId: workspace.id,
      folderId: openFolderId,
      name: 'New collapsible'
    })
    setNaming(made.id)
  }

  /*
   * Right-clicking the page itself. Everything the header's buttons offer, at the
   * pointer — and the third thing, which has no button of its own because a page with
   * three New buttons across the top is a page that has stopped saying what matters.
   */
  const pageMenu: MenuItem[] = [
    {
      label: 'New',
      icon: 'plus',
      items: [
        {
          label: 'Project',
          icon: 'projects',
          onSelect: () => {
            setCreatingIn(null)
            setCreating(true)
          }
        },
        { label: 'Folder', icon: 'folder', onSelect: () => setNewFolderIn(openFolderId) },
        { label: 'Collapsible', icon: 'chevronDown', onSelect: () => void newCollapsible() }
      ]
    }
  ]

  return (
    <>
      {/* The whole page is the target, empty space included — which is why the handler
          sits on a wrapper with a floor under its height rather than on the grid, and
          why the dialogs are left outside it: a right-click in a text field belongs to
          the field. Cards and folders stop the event at their own menu on the way up. */}
      <div
        className="min-h-[70vh]"
        onContextMenu={(e) => {
          if (!showArchived) openMenu(e, pageMenu)
        }}
      >
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

        {visible.length === 0 && subfolders.length === 0 && bands.length === 0 ? (
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

            {/* The archive is a list you are reading, not one you are arranging: nothing
                in it is dragged anywhere, so it is drawn as plain cards. */}
            {showArchived ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            ) : bands.length === 0 ? (
              /* No bands here, so there is nothing to be outside of and the page is the
                 plain grid it has always been — no rule, no heading, no drop strip. */
              <ProjectGrid
                // One arrangement per folder. Keying on the open folder means the grid
                // starts again rather than carrying a half-finished preview across.
                key={openFolderId ?? 'root'}
                projects={loose}
                onDragged={setDragged}
              />
            ) : (
              <>
                <LooseArea
                  key={openFolderId ?? 'root'}
                  projects={loose}
                  carried={carried}
                  onDragged={setDragged}
                  onRelease={(id) => groupHere(id, null)}
                />
                {bands.map((band) => (
                  <CollapsibleSection
                    key={band.id}
                    collapsible={band}
                    projects={visible.filter((p) => p.collapsibleId === band.id)}
                    carried={carried}
                    naming={naming === band.id}
                    onDragged={setDragged}
                    onAdopt={(id) => groupHere(id, band.id)}
                    onNewProject={() => {
                      setCreatingIn(band.id)
                      setCreating(true)
                    }}
                    onNamed={() => setNaming(null)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Keyed on where it will land, so a project started inside a folder or a band is
          created there — and so the form is empty again when that changes. */}
      <NewProjectModal
        key={`${openFolderId ?? 'root'}:${creatingIn ?? ''}`}
        open={creating}
        onClose={() => {
          setCreating(false)
          setCreatingIn(null)
        }}
        folderId={openFolderId}
        collapsibleId={creatingIn}
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
  folderId = null,
  collapsibleId = null
}: {
  open: boolean
  onClose: () => void
  /** Where it lands: the folder you were standing in when you pressed New project. */
  folderId?: string | null
  /** And the band, when it was that band's menu that asked. */
  collapsibleId?: string | null
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
      collapsibleId,
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
