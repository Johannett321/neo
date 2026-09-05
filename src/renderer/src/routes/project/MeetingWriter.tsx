import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { CastMember, MeetingTodo, MeetingView } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { differs, relativeFromIso, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { Avatar, ConfirmButton, EmptyState, Field } from '@/components/primitives'

/**
 * Writing up a meeting is writing, so it gets a page rather than a dialog.
 *
 * The middle is the same Markdown editor a note uses — the write-up is the point, and
 * it deserves the width and the quiet. Everything a meeting has that a note does not
 * lives in the rail on the right, where it can be glanced at and corrected without
 * ever interrupting the sentence being typed: what it was called, when it happened,
 * who was in the room, and what the room left owing.
 *
 * Like the note writer it saves itself, for the same reason: a screen has a sidebar,
 * a back gesture and ⌘K, and losing a page of writing to any of them is not a trade
 * worth making. Unlike the note writer it keeps a real header bar rather than a
 * floating one — the rail needs a top edge to start from.
 */
export function MeetingWriter(): React.JSX.Element {
  const { id: projectId = '', meetingId = '' } = useParams()
  const { data } = useApi('project:get', { id: projectId })
  const navigate = useNavigate()
  const save = useApiMutation('meeting:save')
  const remove = useApiMutation('meeting:delete')

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayStr())
  const [attendees, setAttendees] = useState<string[]>([])
  const [savedAt, setSavedAt] = useState<string | null>(null)

  // The draft lives here, not in the query cache: every save invalidates everything,
  // and a refetch must never overwrite what is being typed.
  const idRef = useRef<string | null>(null)
  const draft = useRef({ title, body, occurredOn, attendees })
  const saved = useRef({ title: '', body: '', occurredOn: '', attendees: [] as string[] })
  const deleted = useRef(false)
  const touched = useRef(false)
  /** Still on screen. A save that lands after you have left must not pull you back. */
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  draft.current = { title, body, occurredOn, attendees }

  const meeting = data?.meetings.find((m) => m.id === meetingId) ?? null
  const cast = data?.cast ?? []
  const missing = Boolean(data) && meetingId !== 'new' && !meeting && idRef.current !== meetingId

  // Loads a meeting once. `new` becomes a real id the moment it first saves, and that
  // must not count as opening a different meeting and reset the page under the cursor.
  useEffect(() => {
    if (meetingId === 'new' || meetingId === idRef.current || !meeting) return
    idRef.current = meeting.id
    touched.current = false
    const next = {
      title: meeting.title,
      body: meeting.body,
      occurredOn: meeting.occurredOn,
      attendees: meeting.attendees.map((a) => a.id)
    }
    saved.current = next
    setTitle(next.title)
    setBody(next.body)
    setOccurredOn(next.occurredOn)
    setAttendees(next.attendees)
    setSavedAt(meeting.updatedAt)
  }, [meetingId, meeting])

  // A meeting you have just started is assumed to have had everyone on the project in
  // the room; unticking who was absent is quicker than remembering who was not.
  const seeded = useRef(false)
  useEffect(() => {
    if (meetingId !== 'new' || seeded.current || cast.length === 0) return
    seeded.current = true
    setAttendees(cast.map((c) => c.personId))
  }, [meetingId, cast])

  const write = useCallback(
    async (force: boolean): Promise<string | null> => {
      if (deleted.current) return idRef.current
      if (!force && !touched.current) return idRef.current
      const next = {
        title: draft.current.title.trim(),
        body: draft.current.body,
        occurredOn: draft.current.occurredOn,
        attendees: draft.current.attendees
      }
      if (!force && !differs(next, saved.current)) return idRef.current
      const result = await save.mutateAsync({
        id: idRef.current ?? undefined,
        projectId,
        title: next.title,
        body: next.body,
        occurredOn: next.occurredOn,
        attendeeIds: next.attendees
      })
      if (deleted.current) return null
      saved.current = next
      idRef.current = result.id
      setSavedAt(result.updatedAt)
      // The URL only needs correcting while the page is still the one you are on.
      // Pressing Back inside the save delay saves the meeting and leaves you on the
      // list, rather than bouncing you into the editor a moment after you left it.
      if (alive.current && meetingId === 'new') {
        navigate(`/projects/${projectId}/meetings/${result.id}`, { replace: true })
      }
      return result.id
    },
    [meetingId, navigate, projectId, save]
  )

  /** A to-do has to belong to something, so asking for one writes the meeting first. */
  const ensureSaved = useCallback(async (): Promise<string | null> => {
    touched.current = true
    return idRef.current ?? (await write(true))
  }, [write])

  // Held in refs so the unmount flush below runs the current one, not the first one.
  const writeRef = useRef(write)
  writeRef.current = write

  const edit = <T,>(set: (v: T) => void) => (value: T): void => {
    touched.current = true
    set(value)
  }

  // Untouched is not unsaved: a page you have only opened has nothing to keep, and
  // a new one starts with today's date and the whole cast already filled in.
  const dirty =
    touched.current && differs({ title: title.trim(), body, occurredOn, attendees }, saved.current)

  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => void writeRef.current(false), 800)
    return () => clearTimeout(timer)
  }, [title, body, occurredOn, attendees, dirty])

  // Leaving the page is the last moment to keep what is on it.
  useEffect(() => () => void writeRef.current(false), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void writeRef.current(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const back = `/projects/${projectId}/meetings`

  if (!data) return <div className="h-full" />
  if (missing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon="people"
          title="That meeting is no longer here."
          hint="It may have been deleted from another screen."
          action={
            <Link className="btn btn-sm" to={back}>
              Back to meetings
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region hairline flex h-[3.25rem] shrink-0 items-center gap-2 border-b px-4">
        <Link
          to={back}
          className="group flex items-center gap-1.5 rounded-field px-2 py-1 text-[12px] text-base-content/50 transition hover:bg-base-content/5 hover:text-base-content"
        >
          <Icon name="arrowLeft" size={13} className="transition-transform group-hover:-translate-x-0.5" />
          Meetings
        </Link>
        <span className="truncate text-[12px] text-base-content/35">{title.trim() || 'Untitled meeting'}</span>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-base-content/35">
          <span className="w-[6.5rem] text-right">
            {dirty ? 'Unsaved…' : savedAt ? `Saved ${relativeFromIso(savedAt)}` : 'Not saved yet'}
          </span>
          {meeting && (
            <ConfirmButton
              label="Delete"
              className="btn btn-ghost btn-sm text-base-content/40 hover:text-error"
              title="Delete this meeting?"
              body={meeting.title || 'Untitled meeting'}
              onConfirm={() => {
                deleted.current = true
                remove.mutate({ id: meeting.id })
                navigate(back, { replace: true })
              }}
            />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-area min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[44rem] px-10 pb-32 pt-10">
            <MarkdownEditor
              value={body}
              onChange={edit(setBody)}
              autoFocus={meetingId !== 'new'}
              placeholder="What was actually said, including the part that was awkward."
              className="min-h-[60vh] px-0.5"
            />
          </div>
        </div>

        <aside className="scroll-area hairline w-[19.5rem] shrink-0 space-y-6 border-l bg-base-200/30 px-5 py-6">
          <Field label="Name">
            <input
              autoFocus={meetingId === 'new'}
              className="input input-bordered input-sm w-full"
              placeholder="Weekly sync, steering committee, client call…"
              value={title}
              onChange={(e) => edit(setTitle)(e.target.value)}
            />
          </Field>

          <Field label="Date">
            <DateField value={occurredOn} onChange={edit(setOccurredOn)} allowClear={false} />
          </Field>

          <Attendees cast={cast} value={attendees} onChange={edit(setAttendees)} />

          <Todos
            projectId={projectId}
            meeting={meeting}
            ensureSaved={ensureSaved}
          />
        </aside>
      </div>
    </div>
  )
}

function Attendees({
  cast,
  value,
  onChange
}: {
  cast: CastMember[]
  value: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const all = cast.map((c) => c.personId)
  const anyOn = value.length > 0

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-base-content/65">Who was there</span>
        {cast.length > 0 && (
          <button
            className="text-[11px] text-base-content/40 transition hover:text-base-content"
            onClick={() => onChange(anyOn ? [] : all)}
          >
            {anyOn ? 'Untick all' : 'Tick all'}
          </button>
        )}
      </div>

      {cast.length === 0 ? (
        <p className="text-[12px] text-base-content/40">
          Nobody on this project yet. Add people first and they will appear here.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {cast.map((member) => {
            const on = value.includes(member.personId)
            return (
              <button
                key={member.personId}
                type="button"
                onClick={() =>
                  onChange(
                    on ? value.filter((id) => id !== member.personId) : [...value, member.personId]
                  )
                }
                className={`flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[12px] transition ${
                  on ? 'border-primary/40 bg-primary/10' : 'hairline text-base-content/45'
                }`}
              >
                <Avatar
                  name={member.name}
                  color={on ? member.avatarColor : '#94a3b8'}
                  image={on ? member.avatar : null}
                  size={18}
                />
                {member.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * What the room left owing. These are deliberately not cards: most of what is said in
 * a meeting is remembered, done and forgotten inside a week, and putting all of it on
 * the board would bury the work that actually needs planning. Right-click promotes the
 * one that turns out to be real, and from then on the card owns whether it is done.
 */
function Todos({
  projectId,
  meeting,
  ensureSaved
}: {
  projectId: string
  meeting: MeetingView | null
  ensureSaved: () => Promise<string | null>
}): React.JSX.Element {
  const saveTodo = useApiMutation('meetingTodo:save')
  const [adding, setAdding] = useState('')
  const todos = meeting?.todos ?? []
  const open = todos.filter((t) => !t.done).length

  const add = async (): Promise<void> => {
    const text = adding.trim()
    if (!text) return
    const meetingId = await ensureSaved()
    if (!meetingId) return
    setAdding('')
    await saveTodo.mutateAsync({ meetingId, text })
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-base-content/65">To do</span>
        {todos.length > 0 && (
          <span className="text-[11px] tabular-nums text-base-content/40">
            {open === 0 ? 'all done' : `${open} still open`}
          </span>
        )}
      </div>

      <div className="space-y-0.5">
        {todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} projectId={projectId} />
        ))}
      </div>

      <input
        className="quiet-input mt-1 w-full rounded-field px-1.5 py-1.5 text-[13px]"
        placeholder="Add an item…"
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
        onBlur={() => void add()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add()
          }
        }}
      />
      {todos.length === 0 && (
        <p className="mt-1.5 text-[11px] text-base-content/35">
          Right-click one to put it on the board.
        </p>
      )}
    </div>
  )
}

function TodoRow({ todo, projectId }: { todo: MeetingTodo; projectId: string }): React.JSX.Element {
  const save = useApiMutation('meetingTodo:save')
  const remove = useApiMutation('meetingTodo:delete')
  const promote = useApiMutation('meetingTodo:promote')
  const openMenu = useContextMenu()
  const navigate = useNavigate()

  const [text, setText] = useState(todo.text)
  const focused = useRef(false)
  // A save invalidates every query, so the row is handed its own text back mid-word
  // unless the one being edited is left alone until it is finished with.
  useEffect(() => {
    if (!focused.current) setText(todo.text)
  }, [todo.text])

  const commit = (): void => {
    const next = text.trim()
    if (!next) {
      setText(todo.text)
      return
    }
    if (next !== todo.text) save.mutate({ id: todo.id, text: next })
  }

  const board = `/projects/${projectId}/kanban`

  return (
    <div
      className="row-hover group flex items-start gap-2 rounded-field px-1.5 py-1"
      onContextMenu={(e) =>
        openMenu(e, [
          todo.taskId
            ? { label: 'Show on the board', icon: 'board', onSelect: () => navigate(board) }
            : {
                label: 'Add to the board',
                icon: 'board',
                onSelect: () => promote.mutate({ id: todo.id })
              },
          {
            label: todo.done ? 'Mark as not done' : 'Mark as done',
            icon: 'check',
            onSelect: () => save.mutate({ id: todo.id, done: !todo.done })
          },
          ...(todo.taskId
            ? [
                {
                  label: 'Take off the board',
                  icon: 'close' as const,
                  onSelect: () => save.mutate({ id: todo.id, taskId: null })
                }
              ]
            : []),
          'separator',
          {
            label: 'Delete item',
            icon: 'trash',
            danger: true,
            onSelect: () => remove.mutate({ id: todo.id }),
            confirm: { title: 'Delete this item?', body: todo.text }
          }
        ])
      }
    >
      <button
        className="mt-0.5 flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border border-base-content/25 text-transparent transition hover:border-primary hover:text-primary/50 data-[done=true]:border-primary data-[done=true]:bg-primary data-[done=true]:text-primary-content"
        data-done={todo.done}
        onClick={() => save.mutate({ id: todo.id, done: !todo.done })}
        aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
      >
        <Icon name="check" size={10} strokeWidth={2.6} />
      </button>

      <div className="min-w-0 flex-1">
        <input
          className={`quiet-input w-full bg-transparent text-[12.5px] leading-snug ${
            todo.done ? 'text-base-content/35 line-through' : ''
          }`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false
            commit()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setText(todo.text)
              e.currentTarget.blur()
            }
          }}
        />
        {/* Promoted items say so, and say where they went. That is the whole visual
            difference: the item has stopped being a reminder and become work. */}
        {todo.taskId && (
          <button
            className="mt-0.5 flex items-center gap-1 text-[10.5px] text-base-content/45 transition hover:text-base-content"
            onClick={() => navigate(board)}
          >
            <Icon name="board" size={10} />
            On the board{todo.taskColumn ? ` · ${todo.taskColumn}` : ''}
          </button>
        )}
      </div>
    </div>
  )
}
