import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApi, useApiMutation } from '@/lib/api'
import { differs, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { ConfirmButton, EmptyState, Kbd } from '@/components/primitives'

/**
 * A page to write on, rather than a box to fill in.
 *
 * A note is Markdown — it is stored as Markdown and mirrored to `~/.neo` as
 * Markdown — and it renders itself as you write it. There is no preview, because a
 * preview is a second copy of the note you have to look away to see: type `## ` and
 * this line becomes a heading with the cursor still in it. See `MarkdownEditor`.
 *
 * It takes the whole window. The project heading, the tabs and the search bar all
 * belong to moving around, and this is the one screen where you are not: the note
 * starts at the top of the window and the only chrome left floats above it.
 *
 * It saves itself. A dialog can afford a Save button because the only ways out of one
 * are deliberate; a screen has a sidebar, a back gesture and ⌘K, and losing a page of
 * writing to any of them is not a trade worth making. The activity log stays readable
 * because repeated saves of the same note inside half an hour collapse into one line.
 */
export function NoteWriter(): React.JSX.Element {
  const { id: projectId = '', noteId = '' } = useParams()
  const { data } = useApi('project:get', { id: projectId })
  const navigate = useNavigate()
  const save = useApiMutation('note:save')
  const remove = useApiMutation('note:delete')

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  // The draft lives here, not in the query cache: every save invalidates everything,
  // and a refetch must never overwrite what is being typed.
  const idRef = useRef<string | null>(null)
  const draft = useRef({ title, body })
  const saved = useRef({ title: '', body: '' })
  const deleted = useRef(false)
  // Nothing is written back until you have actually typed something. Without this the
  // page would save its own empty initial state over the note it is still loading.
  const touched = useRef(false)
  draft.current = { title, body }

  const edit = (set: (v: string) => void) => (value: string): void => {
    touched.current = true
    set(value)
  }

  const note = data?.notes.find((n) => n.id === noteId) ?? null
  const missing = Boolean(data) && noteId !== 'new' && !note && idRef.current !== noteId

  // Loads a note once. `new` becomes a real id the moment it first saves, and that
  // must not count as opening a different note and reset the page under the cursor.
  useEffect(() => {
    if (noteId === 'new' || noteId === idRef.current || !note) return
    idRef.current = note.id
    touched.current = false
    saved.current = { title: note.title, body: note.body }
    setTitle(note.title)
    setBody(note.body)
    setSavedAt(note.updatedAt)
  }, [noteId, note])

  const flush = useCallback(async (): Promise<void> => {
    if (deleted.current || !touched.current) return
    const next = { title: draft.current.title.trim(), body: draft.current.body }
    if (!differs(next, saved.current)) return
    // An untouched blank page is not a note; it is a page you opened and left.
    if (!next.title && !next.body.trim() && !idRef.current) return
    const result = await save.mutateAsync({ id: idRef.current ?? undefined, projectId, ...next })
    if (deleted.current) return
    saved.current = next
    idRef.current = result.id
    setSavedAt(result.updatedAt)
    if (noteId === 'new') navigate(`/projects/${projectId}/notes/${result.id}`, { replace: true })
  }, [navigate, noteId, projectId, save])

  // Held in a ref so the unmount flush below runs the current one, not the first one.
  const flushRef = useRef(flush)
  flushRef.current = flush

  const dirty = differs({ title: title.trim(), body }, saved.current)

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => void flushRef.current(), 800)
    return () => clearTimeout(timer)
  }, [title, body, dirty])

  // Leaving the page is the last moment to keep what is on it.
  useEffect(() => () => void flushRef.current(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flushRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const back = `/projects/${projectId}/notes`
  const words = body.trim() ? body.trim().split(/\s+/).length : 0

  if (!data) return <div className="h-full" />
  if (missing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon="note"
          title="That note is no longer here."
          hint="It may have been deleted from another screen."
          action={
            <Link className="btn btn-sm" to={back}>
              Back to notes
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="relative h-full">
      <div className="scroll-area h-full">
        <div className="mx-auto w-full max-w-[46rem] px-10 pb-32 pt-[4.5rem]">
          <input
            className="quiet-input -mx-2 mb-4 w-full px-2 py-1 text-[26px] font-semibold tracking-[-0.02em]"
            placeholder="Untitled note"
            value={title}
            autoFocus={noteId === 'new'}
            onChange={(e) => edit(setTitle)(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />

          <MarkdownEditor
            value={body}
            onChange={edit(setBody)}
            autoFocus={noteId !== 'new'}
            placeholder="Write. # for a heading, - for a list, - [ ] for a checkbox, ``` for code."
            className="min-h-[60vh] px-0.5"
          />

          {/* Sits under the note rather than over it: a short note sees the hints, and
              a long one has stopped needing them by the time it scrolls past. */}
          <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-base-content/30">
            <span className="flex items-center gap-1.5">
              <Kbd>⌘B</Kbd> bold
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>⌘I</Kbd> italic
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>⌘⇧K</Kbd> link
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>⇥</Kbd> nest
            </span>
          </div>
        </div>
      </div>

      {/*
        The only chrome left, floating over the note rather than pushing it down the
        window. It keeps a drag region across the top edge, which is otherwise the one
        part of a frameless window you can grab.
      */}
      <div className="drag-region absolute inset-x-0 top-0 flex h-[3.25rem] items-center gap-2 bg-base-100/75 px-4 backdrop-blur-sm">
        <Link
          to={back}
          className="group flex items-center gap-1.5 rounded-field px-2 py-1 text-[12px] text-base-content/50 transition hover:bg-base-content/5 hover:text-base-content"
        >
          <Icon name="arrowLeft" size={13} className="transition-transform group-hover:-translate-x-0.5" />
          Notes
        </Link>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-base-content/35">
          <span className="tabular-nums">{words === 1 ? '1 word' : `${words} words`}</span>
          <span>·</span>
          <span className="w-[6.5rem]">
            {dirty ? 'Unsaved…' : savedAt ? `Saved ${relativeFromIso(savedAt)}` : 'Not saved yet'}
          </span>
          {note && (
            <>
              <button
                className={`btn btn-sm btn-circle ${
                  note.isPinned ? 'btn-neutral' : 'btn-ghost text-base-content/40'
                }`}
                title={note.isPinned ? 'Unpin' : 'Pin to the top'}
                onClick={() => save.mutate({ id: note.id, isPinned: !note.isPinned })}
              >
                <Icon name="pin" size={14} />
              </button>
              <ConfirmButton
                label="Delete"
                className="btn btn-ghost btn-sm text-base-content/40 hover:text-error"
                title="Delete this note?"
                body={note.title || 'Untitled note'}
                onConfirm={() => {
                  deleted.current = true
                  remove.mutate({ id: note.id })
                  navigate(back, { replace: true })
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
