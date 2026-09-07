import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Canvas, ContentFolderView, Note } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { relativeFromIso } from '@/lib/format'
import { excerpt } from '@/lib/markdown'
import { Icon } from '@/components/Icon'
import { EmptyState } from '@/components/primitives'
import { MoveToFolderModal } from '@/components/FolderPicker'
import { FolderTrail } from '@/components/FolderTrail'
import {
  CarryableRow, ContentFolderRow, FilingDialogs, useFiling
} from '@/components/ContentFolders'

/**
 * The list is an index, not an editor: a note opens on its own page, because a note
 * is something you write rather than something you fill in. Two lines of the note,
 * with its Markdown stripped back to the words, is enough to recognise which one it is.
 *
 * Once there are enough of them to lose one, they can be filed. A folder is a row in
 * this same list, opening one shows what is inside it and nothing else, and the trail
 * across the top is the way back out — and the way to take a note back out with you.
 * With no folders at all the page is precisely the list it has always been.
 */
type NoteItem = { kind: 'note'; item: Note }
type CanvasItem = { kind: 'canvas'; item: Canvas }
type ListItem = NoteItem | CanvasItem
type FiledItem = { kind: 'note'; item: Note; folderId: string | null } | { kind: 'canvas'; item: Canvas; folderId: string | null }

export function NotesTab({
  projectId,
  notes,
  canvases,
  folders
}: {
  projectId: string
  notes: Note[]
  canvases: Canvas[]
  folders: ContentFolderView[]
}): React.JSX.Element {
  const navigate = useNavigate()
  const openMenu = useContextMenu()
  const filing = useFiling('note', folders)
  const [moving, setMoving] = useState<ListItem | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  // A note or canvas started inside a folder is filed there, so the URL carries where you are.
  const noteHref = (noteId: string): string =>
    `/projects/${projectId}/notes/${noteId}${filing.openFolderId ? `?in=${filing.openFolderId}` : ''}`
  const canvasHref = (canvasId: string): string =>
    `/projects/${projectId}/canvas/${canvasId}${filing.openFolderId ? `?in=${filing.openFolderId}` : ''}`

  const items: ListItem[] = [
    ...notes.map((n) => ({ kind: 'note' as const, item: n })),
    ...canvases.map((c) => ({ kind: 'canvas' as const, item: c }))
  ].sort((a, b) => {
    // Pinned first, then by updated time, with canvases and notes interleaved.
    const pinDiff = Number(b.item.isPinned) - Number(a.item.isPinned)
    if (pinDiff) return pinDiff
    return new Date(b.item.updatedAt).getTime() - new Date(a.item.updatedAt).getTime()
  })

  const filedItems: FiledItem[] = items.map(({ kind, item }) => ({ kind, item, folderId: item.folderId } as FiledItem))
  const here = filing.here(filedItems)

  /*
   * Right-clicking the list itself. The button above offers a note; this is the other
   * thing you can make here, which has no button of its own because a page with two
   * New buttons across the top has stopped saying which one matters.
   */
  const pageMenu: MenuItem[] = [
    {
      label: 'New',
      icon: 'plus',
      items: [
        { label: 'Note', icon: 'note', onSelect: () => navigate(noteHref('new')) },
        { label: 'Canvas', icon: 'canvas', onSelect: () => navigate(canvasHref('new')) },
        filing.newFolderItem
      ]
    }
  ]

  return (
    <>
      {/* The whole pane is the target, empty space included, which is why the handler
          sits on a wrapper with a floor under its height. Rows and folders stop the
          event at their own menu on the way up. */}
      <div className="min-h-[60vh]" onContextMenu={(e) => openMenu(e, pageMenu)}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="group relative">
            <Link className="btn btn-primary btn-sm gap-1.5 rounded-r-none" to={noteHref('new')}>
              <Icon name="plus" size={13} />
              New note
            </Link>
            <button
              className="btn btn-primary btn-sm rounded-l-none border-l border-l-primary-content/25 px-1.5"
              title="More new options"
              aria-haspopup="menu"
              onClick={(e) => {
                setNewOpen(true)
                openMenu(e, [
                  { label: 'New note', icon: 'note', onSelect: () => navigate(noteHref('new')) },
                  { label: 'New canvas', icon: 'canvas', onSelect: () => navigate(canvasHref('new')) }
                ])
              }}
              onBlur={() => setNewOpen(false)}
            >
              <Icon name={newOpen ? 'chevronUp' : 'chevronDown'} size={13} />
            </button>
          </div>
          <button
            className="btn btn-ghost btn-sm gap-1.5"
            onClick={() => filing.setNewFolderIn(filing.openFolderId)}
          >
            <Icon name="folder" size={13} />
            New folder
          </button>
          {/* Only ever drawn once you are inside something. With no folders there is no
              trail, and the page is exactly what it has always been. */}
          {filing.crumbs.length > 0 && (
            <span className="min-w-0 text-[12px] text-base-content/50">
              <FolderTrail
                crumbs={filing.crumbs}
                folders={filing.folders}
                dragged={filing.dragged}
                rootLabel="All notes"
                onOpen={filing.open}
                onMoveHere={filing.moveHere}
              />
            </span>
          )}
        </div>

        {filing.subfolders.length > 0 && (
          <div className="mb-4 space-y-2">
            {filing.subfolders.map((folder) => (
              <ContentFolderRow key={folder.id} folder={folder} filing={filing} noun="note" />
            ))}
          </div>
        )}

        {here.length === 0 && filing.subfolders.length === 0 ? (
          <EmptyState
            icon={filing.openFolderId ? 'folder' : 'note'}
            title={filing.openFolderId ? 'Nothing in this folder yet.' : 'No notes yet.'}
            hint={
              filing.openFolderId
                ? 'Drag a note onto a folder to file it, or start one in here.'
                : 'Meeting notes, the thing someone said in a corridor, the constraint you will otherwise forget.'
            }
          />
        ) : (
          <div className="space-y-2.5">
            {here.map(({ kind, item }) =>
              kind === 'note' ? (
                <NoteRow
                  key={item.id}
                  note={item}
                  filing={filing}
                  href={noteHref(item.id)}
                  onMove={() => setMoving({ kind: 'note', item })}
                />
              ) : (
                <CanvasRow
                  key={item.id}
                  canvas={item}
                  filing={filing}
                  href={canvasHref(item.id)}
                  onMove={() => setMoving({ kind: 'canvas', item })}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Outside the wrapper above: a right-click in a text field belongs to the field. */}
      <FilingDialogs projectId={projectId} filing={filing} noun="note" />

      {moving && (
        <MoveToFolderModal
          key={moving.item.id}
          open
          onClose={() => setMoving(null)}
          folders={filing.pickable}
          title={`Move ${moving.item.title || `this ${moving.kind}`}`}
          description="Filing only. Nothing about the item itself changes."
          current={moving.item.folderId}
          onMove={(folderId) => filing.file(moving.item.id, folderId, moving.kind === 'canvas' ? 'canvas' : 'note')}
        />
      )}
    </>
  )
}

function NoteRow({
  note,
  filing,
  href,
  onMove
}: {
  note: Note
  filing: ReturnType<typeof useFiling>
  href: string
  onMove: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')
  const openMenu = useContextMenu()

  return (
    <CarryableRow id={note.id} filing={filing} type="note">
      <Link
        to={href}
        draggable={false}
        className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
        onContextMenu={(e) =>
          openMenu(e, [
            { label: 'Open', icon: 'edit', onSelect: () => navigate(href) },
            {
              label: note.isPinned ? 'Unpin' : 'Pin',
              icon: 'pin',
              onSelect: () => save.mutate({ id: note.id, isPinned: !note.isPinned })
            },
            { label: 'Move to…', icon: 'folder', onSelect: onMove },
            'separator',
            {
              label: 'Delete note',
              icon: 'trash',
              danger: true,
              onSelect: () => remove.mutate({ id: note.id }),
              confirm: { title: 'Delete this note?', body: note.title || 'Untitled note' }
            }
          ])
        }
      >
        <div className="flex items-center gap-2">
          {note.isPinned && <Icon name="pin" size={12} className="text-warning" />}
          <span className="flex-1 truncate text-[13px] font-medium">{note.title || 'Untitled note'}</span>
          <span className="shrink-0 text-[11px] text-base-content/35">{relativeFromIso(note.updatedAt)}</span>
        </div>
        {note.body && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-base-content/55">
            {excerpt(note.body)}
          </p>
        )}
      </Link>
    </CarryableRow>
  )
}

function CanvasRow({
  canvas,
  filing,
  href,
  onMove
}: {
  canvas: Canvas
  filing: ReturnType<typeof useFiling>
  href: string
  onMove: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const save = useApiMutation('canvas:save')
  const remove = useApiMutation('canvas:delete')
  const openMenu = useContextMenu()
  const nodeCount = canvas.data.nodes.filter((n) => n.type === 'text').length

  return (
    <CarryableRow id={canvas.id} filing={filing} type="canvas">
      <Link
        to={href}
        draggable={false}
        className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
        onContextMenu={(e) =>
          openMenu(e, [
            { label: 'Open', icon: 'canvas', onSelect: () => navigate(href) },
            {
              label: canvas.isPinned ? 'Unpin' : 'Pin',
              icon: 'pin',
              onSelect: () => save.mutate({ id: canvas.id, isPinned: !canvas.isPinned })
            },
            { label: 'Move to…', icon: 'folder', onSelect: onMove },
            'separator',
            {
              label: 'Delete canvas',
              icon: 'trash',
              danger: true,
              onSelect: () => remove.mutate({ id: canvas.id }),
              confirm: { title: 'Delete this canvas?', body: canvas.title || 'Untitled canvas' }
            }
          ])
        }
      >
        <div className="flex items-center gap-2">
          {canvas.isPinned && <Icon name="pin" size={12} className="text-warning" />}
          <Icon name="canvas" size={14} className="text-base-content/40" />
          <span className="flex-1 truncate text-[13px] font-medium">{canvas.title || 'Untitled canvas'}</span>
          <span className="shrink-0 text-[11px] text-base-content/35">
            {nodeCount} card{nodeCount === 1 ? '' : 's'} · {relativeFromIso(canvas.updatedAt)}
          </span>
        </div>
      </Link>
    </CarryableRow>
  )
}
