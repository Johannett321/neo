import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import type { ContentFolderView, ContentKind } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuAction, MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { branchIds, childrenOf, crumbsOf, type Dragged } from '@/lib/folders'
import { plural } from '@/lib/format'
import { EASE } from '@/lib/motion'
import { Icon } from './Icon'
import { MoveToFolderModal, NewFolderModal } from './FolderPicker'

/**
 * Filing the two lists inside a project: the notes and the meetings.
 *
 * The same idea as the folders on the projects page, drawn for a list rather than a
 * grid. A folder is a row among the rows, opening one replaces the list with what is
 * inside it, and the trail across the top is the way back — the way a file browser
 * works, and the way anyone expects one to work without being told.
 *
 * It is written once for both lists because a note and a meeting are the same shape of
 * thing filed in the same way; only the word on the screen differs, and that is a prop.
 * And it is written for the person who will never make a folder: with none, both pages
 * are exactly the lists they were before any of this existed. No headings, no trail,
 * no empty scaffolding for a feature you are not using.
 */

/** How long a row takes to slide out of the way. Long enough to be followed. */
const SLIDE = { duration: 0.22, ease: EASE } as const

/** Everything a page needs to draw its folders, and to file things into them. */
export interface Filing {
  kind: ContentKind
  /** Every folder in this list, depth-first. */
  folders: ContentFolderView[]
  /** The trail down to the open folder, that folder last. Empty at the top level. */
  crumbs: ContentFolderView[]
  openFolderId: string | null
  open: (folderId: string | null) => void
  /** The folders drawn at this level, and no others. */
  subfolders: ContentFolderView[]
  dragged: Dragged | null
  setDragged: (dragged: Dragged | null) => void
  /** File whatever is in the air into a folder, or out to the level above it. */
  moveHere: (dragged: Dragged, folderId: string | null) => void
  /** Move one thing, by id, from a menu rather than by dragging. */
  file: (id: string, folderId: string | null) => void
  /** Whatever is filed at the level you are looking at, and nothing else. */
  here: <T extends { folderId: string | null }>(items: T[]) => T[]
  newFolderIn: string | null | undefined
  setNewFolderIn: (parentId: string | null | undefined) => void
  movingFolder: ContentFolderView | null
  setMovingFolder: (folder: ContentFolderView | null) => void
  /** The entry every page's own right-click menu carries. */
  newFolderItem: MenuAction
  /** The folder tree as the pickers want it. */
  pickable: { id: string; name: string; depth: number; count: number }[]
}

/**
 * The state behind filing one list: where you are in it, what is in the air, and the
 * writes that move things about.
 *
 * Which folder is open lives in the URL, so the back button walks back up the way it
 * does in a file browser and a reload lands you where you were. Notes and meetings are
 * separate routes, so the one parameter serves both without ever meeting.
 */
export function useFiling(kind: ContentKind, folders: ContentFolderView[]): Filing {
  const [params, setParams] = useSearchParams()
  const [dragged, setDragged] = useState<Dragged | null>(null)
  const [newFolderIn, setNewFolderIn] = useState<string | null | undefined>(undefined)
  const [movingFolder, setMovingFolder] = useState<ContentFolderView | null>(null)

  const saveNote = useApiMutation('note:save')
  const saveMeeting = useApiMutation('meeting:save')
  const saveFolder = useApiMutation('contentFolder:save')

  /*
   * A folder can go while you are standing in it — from another window, from the
   * assistant, from a menu. Reading the open folder back off the trail rather than off
   * the URL is what turns that into "you are at the top" instead of a blank page.
   */
  const crumbs = crumbsOf(folders, params.get('in'))
  const openFolderId = crumbs.length > 0 ? crumbs[crumbs.length - 1].id : null

  const open = (folderId: string | null): void => {
    setParams(folderId ? { in: folderId } : {})
  }

  /** The write that files one note or one meeting. The only thing `kind` decides. */
  const file = (id: string, folderId: string | null): void => {
    if (kind === 'note') saveNote.mutate({ id, folderId })
    else saveMeeting.mutate({ id, folderId })
  }

  const moveHere = (item: Dragged, folderId: string | null): void => {
    if (item.kind === 'item') file(item.id, folderId)
    else if (item.id !== folderId) saveFolder.mutate({ id: item.id, parentId: folderId })
    setDragged(null)
  }

  return {
    kind,
    folders,
    crumbs,
    openFolderId,
    open,
    subfolders: childrenOf(folders, openFolderId),
    dragged,
    setDragged,
    moveHere,
    file,
    here: (items) => items.filter((i) => (i.folderId ?? null) === openFolderId),
    newFolderIn,
    setNewFolderIn,
    movingFolder,
    setMovingFolder,
    newFolderItem: {
      label: 'Folder',
      icon: 'folder',
      onSelect: () => setNewFolderIn(openFolderId)
    },
    pickable: folders.map((f) => ({
      id: f.id,
      name: f.name,
      depth: f.depth,
      count: f.itemCount
    }))
  }
}

/**
 * One folder, as a row among the rows.
 *
 * Deliberately quieter than what it holds: a note is writing and a folder is only
 * somewhere to put it, so it says what is inside and stops there. Drop a note on it to
 * file it; drop another folder on it to move that one in.
 */
export function ContentFolderRow({
  folder,
  filing,
  noun
}: {
  folder: ContentFolderView
  filing: Filing
  /** What this list files, in the singular: "note", "meeting". */
  noun: string
}): React.JSX.Element {
  const save = useApiMutation('contentFolder:save')
  const remove = useApiMutation('contentFolder:delete')
  const openMenu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [over, setOver] = useState(false)
  const { dragged, folders } = filing

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
    { label: 'New folder inside', icon: 'plus', onSelect: () => filing.setNewFolderIn(folder.id) },
    { label: 'Move to…', icon: 'folder', onSelect: () => filing.setMovingFolder(folder) },
    'separator',
    {
      label: 'Delete folder',
      icon: 'trash',
      danger: true,
      onSelect: () => remove.mutate({ id: folder.id }),
      confirm: {
        title: `Delete the folder ${folder.name}?`,
        body: `Only the folder goes. Everything filed in it — ${noun}s and any folders inside — moves up a level.`,
        confirmLabel: 'Delete folder'
      }
    }
  ]

  const inside = [
    folder.itemCount > 0 ? plural(folder.itemCount, noun) : '',
    folder.folderCount > 0 ? plural(folder.folderCount, 'folder') : ''
  ].filter(Boolean)

  return (
    <button
      draggable={!renaming}
      onClick={() => !renaming && filing.open(folder.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        filing.setDragged({ kind: 'folder', id: folder.id })
      }}
      onDragEnd={() => filing.setDragged(null)}
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
        if (dragged && accepts) filing.moveHere(dragged, folder.id)
      }}
      onContextMenu={(e) => openMenu(e, items)}
      className={`hairline flex w-full items-center gap-3 rounded-box border px-4 py-2.5 text-left transition ${
        over
          ? 'border-primary bg-primary/10'
          : accepts
            ? // Something is in the air and this is somewhere it can land.
              'border-dashed border-primary/40 bg-base-100'
            : 'bg-base-100 hover:border-base-content/20'
      }`}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-base-content/[0.06]">
        <Icon name="folder" size={15} className="text-base-content/45" />
      </span>
      <span className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={folder.name}
            className="input input-bordered input-xs w-full max-w-xs text-[13px]"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') rename((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="block truncate text-[13px] font-medium">{folder.name}</span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-base-content/35">
        {inside.length ? inside.join(' · ') : 'Empty'}
      </span>
      <Icon name="chevronRight" size={13} className="shrink-0 text-base-content/25" />
    </button>
  )
}

/**
 * A row you pick up.
 *
 * The row inside is a link with its own dragging turned off, so this is the drag
 * source and the browser's drag image is a picture of the row itself — the thing you
 * grabbed follows the pointer, rather than a ghost of a URL.
 *
 * It fades and settles back *on the next frame* rather than immediately, and that is
 * not a detail: the drag image is snapshotted at the end of the `dragstart` event, so
 * dimming the row now would put the dimmed version into the picture as well. One frame
 * later the snapshot has been taken, and what is left in the list is the quiet outline
 * of where the row will come back to if you let go over nothing.
 */
export function CarryableRow({
  id,
  filing,
  children
}: {
  id: string
  filing: Filing
  children: React.ReactNode
}): React.JSX.Element {
  const reduced = useReducedMotion()
  const [lifted, setLifted] = useState(false)
  const carried = lifted && filing.dragged?.kind === 'item' && filing.dragged.id === id

  return (
    <motion.div
      layout={reduced ? false : 'position'}
      transition={SLIDE}
      animate={reduced ? undefined : { opacity: carried ? 0.35 : 1, scale: carried ? 0.98 : 1 }}
    >
      {/* The drag handlers sit on a plain element inside the animated one on purpose:
          a motion component spells `onDragStart` differently, for dragging of its own. */}
      <div
        draggable
        className="cursor-grab active:cursor-grabbing"
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          filing.setDragged({ kind: 'item', id })
          requestAnimationFrame(() => setLifted(true))
        }}
        onDragEnd={() => {
          setLifted(false)
          filing.setDragged(null)
        }}
      >
        {children}
      </div>
    </motion.div>
  )
}

/**
 * The two dialogs filing needs, rendered once per page. They live here rather than at
 * the call sites so that both lists ask the same questions in the same words.
 */
export function FilingDialogs({
  projectId,
  filing,
  noun
}: {
  projectId: string
  filing: Filing
  noun: string
}): React.JSX.Element {
  const save = useApiMutation('contentFolder:save')

  return (
    <>
      {filing.newFolderIn !== undefined && (
        <NewFolderModal
          key={filing.newFolderIn ?? 'root'}
          open
          onClose={() => filing.setNewFolderIn(undefined)}
          folders={filing.pickable}
          parentId={filing.newFolderIn}
          description={`Somewhere to file ${noun}s in this project. It holds nothing else, and nothing in the app reads it back.`}
          onCreate={(name, parentId) =>
            save.mutateAsync({ projectId, kind: filing.kind, name, parentId })
          }
        />
      )}

      {filing.movingFolder && (
        <MoveToFolderModal
          key={filing.movingFolder.id}
          open
          onClose={() => filing.setMovingFolder(null)}
          folders={filing.pickable}
          title={`Move ${filing.movingFolder.name}`}
          description="Everything filed inside it comes along."
          current={filing.movingFolder.parentId}
          // Into itself, or into one of its own children: the branch would still be
          // there and nothing would ever draw it again.
          exclude={branchIds(filing.folders, filing.movingFolder.id)}
          onMove={(parentId) =>
            filing.movingFolder && save.mutate({ id: filing.movingFolder.id, parentId })
          }
        />
      )}
    </>
  )
}
