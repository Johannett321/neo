import { useEffect, useState } from 'react'
import type { Note } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { differs, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { ConfirmButton, EmptyState, Field, Modal } from '@/components/primitives'

export function NotesTab({ projectId, notes }: { projectId: string; notes: Note[] }): React.JSX.Element {
  const [editing, setEditing] = useState<Note | null>(null)
  const [creating, setCreating] = useState(false)
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')
  const openMenu = useContextMenu()

  return (
    <div>
      <button className="btn btn-primary btn-sm mb-4 gap-1.5" onClick={() => setCreating(true)}>
        <Icon name="plus" size={13} />
        New note
      </button>

      {notes.length === 0 ? (
        <EmptyState
          icon="note"
          title="No notes yet."
          hint="Meeting notes, the thing someone said in a corridor, the constraint you will otherwise forget."
        />
      ) : (
        <div className="space-y-2.5">
          {notes.map((note) => (
            <button
              key={note.id}
              className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
              onClick={() => setEditing(note)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Edit…', icon: 'edit', onSelect: () => setEditing(note) },
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
                  {note.body}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      <NoteModal
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        note={editing}
        projectId={projectId}
        onPinToggle={(note) => save.mutate({ id: note.id, isPinned: !note.isPinned })}
      />
    </div>
  )
}

function NoteModal({
  open,
  onClose,
  note,
  projectId,
  onPinToggle
}: {
  open: boolean
  onClose: () => void
  note: Note | null
  projectId: string
  onPinToggle: (note: Note) => void
}): React.JSX.Element {
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(note?.title ?? '')
    setBody(note?.body ?? '')
  }, [open, note])

  const submit = async (): Promise<void> => {
    if (!title.trim() && !body.trim()) return
    await save.mutateAsync({ id: note?.id, projectId, title: title.trim(), body })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={note ? 'Note' : 'New note'}
      width="max-w-2xl"
      isDirty={differs({ title, body }, { title: note?.title ?? '', body: note?.body ?? '' })}
      footer={
        <>
          {note && (
            <>
              <ConfirmButton
                label="Delete"
                className="btn btn-ghost btn-sm mr-auto text-base-content/50 hover:text-error"
                onConfirm={async () => {
                  await remove.mutateAsync({ id: note.id })
                  onClose()
                }}
              />
              <button className="btn btn-ghost btn-sm gap-1.5" onClick={() => onPinToggle(note)}>
                <Icon name="pin" size={13} />
                {note.isPinned ? 'Unpin' : 'Pin'}
              </button>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void submit()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <input
            autoFocus
            className="input input-bordered w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Note">
          <textarea
            className="textarea textarea-bordered min-h-64 w-full text-sm leading-relaxed"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        </Field>
      </div>
    </Modal>
  )
}
