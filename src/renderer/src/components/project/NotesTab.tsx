import { Link, useNavigate } from 'react-router-dom'
import type { Note } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { relativeFromIso } from '@/lib/format'
import { excerpt } from '@/lib/markdown'
import { Icon } from '@/components/Icon'
import { EmptyState } from '@/components/primitives'

/**
 * The list is an index, not an editor: a note opens on its own page, because a note
 * is something you write rather than something you fill in. Two lines of the note,
 * with its Markdown stripped back to the words, is enough to recognise which one it is.
 */
export function NotesTab({ projectId, notes }: { projectId: string; notes: Note[] }): React.JSX.Element {
  const navigate = useNavigate()
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')
  const openMenu = useContextMenu()
  const href = (noteId: string): string => `/projects/${projectId}/notes/${noteId}`

  return (
    <div>
      <Link className="btn btn-primary btn-sm mb-4 gap-1.5" to={href('new')}>
        <Icon name="plus" size={13} />
        New note
      </Link>

      {notes.length === 0 ? (
        <EmptyState
          icon="note"
          title="No notes yet."
          hint="Meeting notes, the thing someone said in a corridor, the constraint you will otherwise forget."
        />
      ) : (
        <div className="space-y-2.5">
          {notes.map((note) => (
            <Link
              key={note.id}
              to={href(note.id)}
              className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Open', icon: 'edit', onSelect: () => navigate(href(note.id)) },
                  {
                    label: note.isPinned ? 'Unpin' : 'Pin',
                    icon: 'pin',
                    onSelect: () => save.mutate({ id: note.id, isPinned: !note.isPinned })
                  },
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
          ))}
        </div>
      )}
    </div>
  )
}
