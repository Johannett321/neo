import { useState } from 'react'
import type { ProjectFolderView, ProjectSummary } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { branchIds } from '@/lib/folders'
import { plural } from '@/lib/format'
import { Icon } from './Icon'
import { ProjectCard } from './ProjectCard'

/**
 * Folders on the projects page.
 *
 * A folder is a **card in the same grid**, and opening one shows what is inside it and
 * nothing else — the way a folder behaves in Finder, and the way anyone expects one to
 * behave without being told. That is the whole design, and it is chosen for the person
 * who will never make a folder at all: with none, the page is exactly the grid of
 * project cards it has always been. No headings, no chevrons, no empty scaffolding for
 * a feature you are not using.
 */

/** What is currently being dragged. Projects and folders both move by dragging. */
export interface Dragged {
  kind: 'project' | 'folder'
  id: string
}

/**
 * One folder, as a card.
 *
 * It is deliberately quieter than a project card: a project is work and a folder is
 * only somewhere to put it, so it says what is inside and stops there. Drop a project
 * on it to file it; drop another folder on it to move that one in.
 */
export function FolderCard({
  folder,
  folders,
  dragged,
  onOpen,
  onDragged,
  onMoveHere,
  onNewSubfolder,
  onMove
}: {
  folder: ProjectFolderView
  /** Every folder in the workspace — what a move has to check itself against. */
  folders: ProjectFolderView[]
  dragged: Dragged | null
  onOpen: () => void
  onDragged: (dragged: Dragged | null) => void
  onMoveHere: (dragged: Dragged, folderId: string) => void
  onNewSubfolder: () => void
  onMove: () => void
}): React.JSX.Element {
  const save = useApiMutation('folder:save')
  const remove = useApiMutation('folder:delete')
  const openMenu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [over, setOver] = useState(false)

  // A folder is not a target for its own branch: moving one inside itself would leave
  // the rows there with nothing on earth able to draw them again.
  const accepts =
    dragged !== null &&
    (dragged.kind === 'project' || !branchIds(folders, dragged.id).has(folder.id))

  const rename = (name: string): void => {
    setRenaming(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== folder.name) save.mutate({ id: folder.id, name: trimmed })
  }

  const items: MenuItem[] = [
    // No "Open": clicking the folder is how you open it, and a menu item for the
    // gesture that summoned the menu earns nothing.
    { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) },
    { label: 'New folder inside', icon: 'plus', onSelect: onNewSubfolder },
    { label: 'Move to…', icon: 'folder', onSelect: onMove },
    'separator',
    {
      label: 'Delete folder',
      icon: 'trash',
      danger: true,
      onSelect: () => remove.mutate({ id: folder.id }),
      confirm: {
        title: `Delete the folder ${folder.name}?`,
        body: 'Only the folder goes. Everything filed in it — projects and any folders inside — moves up a level.',
        confirmLabel: 'Delete folder'
      }
    }
  ]

  const inside = [
    folder.projectCount > 0 ? plural(folder.projectCount, 'project') : '',
    folder.folderCount > 0 ? plural(folder.folderCount, 'folder') : ''
  ].filter(Boolean)

  return (
    <button
      draggable={!renaming}
      onClick={() => !renaming && onOpen()}
      onDragStart={() => onDragged({ kind: 'folder', id: folder.id })}
      onDragEnd={() => onDragged(null)}
      onDragOver={(e) => {
        if (!accepts) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={() => {
        setOver(false)
        if (dragged && accepts) onMoveHere(dragged, folder.id)
      }}
      onContextMenu={(e) => openMenu(e, items)}
      className={`hairline flex items-center gap-3 rounded-box border p-3 text-left transition ${
        over
          ? 'border-primary bg-primary/10'
          : accepts
            ? // Something is in the air and this is somewhere it can land.
              'border-dashed border-primary/40 bg-base-100'
            : 'bg-base-100 hover:border-base-content/20 hover:shadow-sm'
      }`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-base-content/[0.06]">
        <Icon name="folder" size={17} className="text-base-content/45" />
      </span>
      <span className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            className="input input-bordered input-xs w-full text-[13px]"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') rename((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="block truncate text-[14px] font-medium tracking-[-0.01em]">
            {folder.name}
          </span>
        )}
        <span className="mt-0.5 block text-[11px] text-base-content/40">
          {inside.length ? inside.join(' · ') : 'Empty'}
        </span>
      </span>
      <Icon name="chevronRight" size={14} className="shrink-0 text-base-content/25" />
    </button>
  )
}

/**
 * A card you pick up.
 *
 * The card inside is a link with its own dragging turned off, so this wrapper is the
 * drag source and the browser's drag image is a picture of the card itself — the thing
 * you grabbed follows the pointer, rather than a ghost of a URL.
 *
 * The card is faded *on the next frame* rather than immediately, and that is not a
 * detail: the drag image is snapshotted at the end of this event, so styling the
 * element now would put the fade into the picture as well and leave a ghost you can
 * barely see. One frame later the snapshot has already been taken, and all that is
 * left is the gap the card came out of.
 */
export function DraggableCard({
  project,
  onDragged
}: {
  project: ProjectSummary
  onDragged: (dragged: Dragged | null) => void
}): React.JSX.Element {
  const [lifted, setLifted] = useState(false)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragged({ kind: 'project', id: project.id })
        requestAnimationFrame(() => setLifted(true))
      }}
      onDragEnd={() => {
        setLifted(false)
        onDragged(null)
      }}
      className={`cursor-grab transition active:cursor-grabbing ${
        lifted ? 'scale-[0.98] opacity-40' : ''
      }`}
    >
      <ProjectCard project={project} />
    </div>
  )
}

/**
 * The way back out, and only drawn when there is one: at the top level there are no
 * crumbs, so someone who never makes a folder never sees this line at all.
 *
 * Every crumb above the one you are in is also a drop target, which is how something
 * gets back *out* of a folder — the same gesture that put it in, aimed one level up.
 */
export function FolderBreadcrumbs({
  crumbs,
  folders,
  dragged,
  onOpen,
  onMoveHere
}: {
  crumbs: ProjectFolderView[]
  folders: ProjectFolderView[]
  dragged: Dragged | null
  onOpen: (folderId: string | null) => void
  onMoveHere: (dragged: Dragged, folderId: string | null) => void
}): React.JSX.Element {
  const [over, setOver] = useState<string | null | undefined>(undefined)

  // Dropping something into the folder it is already open in is not a move, so the
  // last crumb takes nothing; everything above it does.
  const above = crumbs.slice(0, -1).map((c) => c.id)
  const accepts = (id: string | null): boolean => {
    if (!dragged) return false
    if (id !== null && !above.includes(id)) return false
    return dragged.kind === 'project' || id === null || !branchIds(folders, dragged.id).has(id)
  }

  const crumb = (id: string | null, label: string, last: boolean): React.JSX.Element => (
    <span key={id ?? 'root'} className="flex min-w-0 items-center gap-1">
      <button
        className={`truncate rounded px-1 py-0.5 transition ${
          over === id ? 'bg-primary/15 text-base-content' : ''
        } ${last ? 'text-base-content/70' : 'hover:bg-base-content/5 hover:text-base-content'}`}
        onClick={() => onOpen(id)}
        onDragOver={(e) => {
          if (!accepts(id)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setOver(id)
        }}
        onDragLeave={() => setOver(undefined)}
        onDrop={() => {
          setOver(undefined)
          if (dragged && accepts(id)) onMoveHere(dragged, id)
        }}
      >
        {label}
      </button>
      {!last && <Icon name="chevronRight" size={11} className="shrink-0 opacity-30" />}
    </span>
  )

  return (
    <span className="flex min-w-0 items-center gap-1">
      {crumb(null, 'All projects', crumbs.length === 0)}
      {crumbs.map((folder, index) => crumb(folder.id, folder.name, index === crumbs.length - 1))}
    </span>
  )
}
