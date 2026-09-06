import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ContentFolderView, Note } from '@shared/types'
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
export function NotesTab({
  projectId,
  notes,
  folders
}: {
  projectId: string
  notes: Note[]
  folders: ContentFolderView[]
}): React.JSX.Element {
  const navigate = useNavigate()
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')
  const openMenu = useContextMenu()
  const filing = useFiling('note', folders)
  const [moving, setMoving] = useState<Note | null>(null)

  // A note started inside a folder is filed there, so the URL carries where you are.
  const href = (noteId: string): string =>
    `/projects/${projectId}/notes/${noteId}${filing.openFolderId ? `?in=${filing.openFolderId}` : ''}`

  const here = filing.here(notes)

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
        { label: 'Note', icon: 'note', onSelect: () => navigate(href('new')) },
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
          <Link className="btn btn-primary btn-sm gap-1.5" to={href('new')}>
            <Icon name="plus" size={13} />
            New note
          </Link>
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
            {here.map((note) => (
              <CarryableRow key={note.id} id={note.id} filing={filing}>
                <Link
                  to={href(note.id)}
                  draggable={false}
                  className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: 'Open', icon: 'edit', onSelect: () => navigate(href(note.id)) },
                      {
                        label: note.isPinned ? 'Unpin' : 'Pin',
                        icon: 'pin',
                        onSelect: () => save.mutate({ id: note.id, isPinned: !note.isPinned })
                      },
                      { label: 'Move to…', icon: 'folder', onSelect: () => setMoving(note) },
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
                    <span className="flex-1 truncate text-[13px] font-medium">
                      {note.title || 'Untitled note'}
                    </span>
                    <span className="shrink-0 text-[11px] text-base-content/35">
                      {relativeFromIso(note.updatedAt)}
                    </span>
                  </div>
                  {note.body && (
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-base-content/55">
                      {excerpt(note.body)}
                    </p>
                  )}
                </Link>
              </CarryableRow>
            ))}
          </div>
        )}
      </div>

      {/* Outside the wrapper above: a right-click in a text field belongs to the field. */}
      <FilingDialogs projectId={projectId} filing={filing} noun="note" />

      {moving && (
        <MoveToFolderModal
          key={moving.id}
          open
          onClose={() => setMoving(null)}
          folders={filing.pickable}
          title={`Move ${moving.title || 'this note'}`}
          description="Filing only. Nothing about the note itself changes."
          current={moving.folderId}
          onMove={(folderId) => filing.file(moving.id, folderId)}
        />
      )}
    </>
  )
}
