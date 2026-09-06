import { useState } from 'react'
import type { ProjectFolderView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { branchIds, type Dragged } from '@/lib/folders'
import { plural } from '@/lib/format'
import { Icon } from './Icon'

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
    (dragged.kind === 'item' || !branchIds(folders, dragged.id).has(folder.id))

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
