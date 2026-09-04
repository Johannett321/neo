import { useEffect, useState } from 'react'
import type { CastMember, MeetingView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { differs, formatDate, plural, todayStr } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { Avatar, ConfirmButton, EmptyState, Field, Modal } from '@/components/primitives'
import { useProject } from './ProjectLayout'

/**
 * A meeting is a note that knows when it happened and who was there. That is the
 * difference that matters: months later the question is never "what was written",
 * it is "who was in the room when we agreed this".
 */
export function ProjectMeetings(): React.JSX.Element {
  const { project, meetings, cast } = useProject()
  const [editing, setEditing] = useState<MeetingView | null>(null)
  const [creating, setCreating] = useState(false)
  const remove = useApiMutation('meeting:delete')
  const openMenu = useContextMenu()

  const last = meetings[0]

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}>
          <Icon name="plus" size={13} />
          Log a meeting
        </button>
        {last && (
          <span className="text-[11px] text-base-content/40">
            Last one {formatDate(last.occurredOn)} · {plural(last.attendees.length, 'person', 'people')}
          </span>
        )}
      </div>

      {meetings.length === 0 ? (
        <EmptyState
          icon="people"
          title="No meetings recorded."
          hint="Agenda, who was there, what was said and what came out of it. Five minutes afterwards saves an hour later."
        />
      ) : (
        <div className="space-y-2.5">
          {meetings.map((meeting) => (
            <button
              key={meeting.id}
              className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
              onClick={() => setEditing(meeting)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Edit…', icon: 'edit', onSelect: () => setEditing(meeting) },
                  'separator',
                  {
                    label: 'Delete meeting',
                    icon: 'trash',
                    danger: true,
                    onSelect: () => remove.mutate({ id: meeting.id }),
                    confirm: {
                      title: 'Delete this meeting?',
                      body: meeting.title || formatDate(meeting.occurredOn)
                    }
                  }
                ])
              }
            >
              <div className="flex items-baseline gap-3">
                <span className="flex-1 truncate text-[13px] font-medium">{meeting.title || 'Meeting'}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-base-content/45">
                  {formatDate(meeting.occurredOn)}
                  {meeting.startsAt && ` · ${meeting.startsAt}`}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                {meeting.attendees.length > 0 ? (
                  <span className="flex -space-x-1.5">
                    {meeting.attendees.slice(0, 5).map((person) => (
                      <span key={person.id} className="rounded-full ring-2 ring-base-100">
                        <Avatar name={person.name} color={person.color} image={person.avatar} size={20} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-[11px] text-base-content/30">Nobody recorded</span>
                )}
                {meeting.location && (
                  <span className="text-[11px] text-base-content/40">{meeting.location}</span>
                )}
              </div>

              {meeting.body && (
                <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-base-content/60">
                  {meeting.body}
                </p>
              )}
              {meeting.actions && (
                <p className="mt-1.5 line-clamp-1 text-[11px] text-base-content/45">
                  <span className="font-medium">Actions:</span> {meeting.actions.replace(/\n/g, ' · ')}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      <MeetingModal
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        meeting={editing}
        projectId={project.id}
        cast={cast}
      />
    </div>
  )
}

function MeetingModal({
  open,
  onClose,
  meeting,
  projectId,
  cast
}: {
  open: boolean
  onClose: () => void
  meeting: MeetingView | null
  projectId: string
  cast: CastMember[]
}): React.JSX.Element {
  const save = useApiMutation('meeting:save')
  const remove = useApiMutation('meeting:delete')
  const [form, setForm] = useState({
    title: '', occurredOn: '', startsAt: '', location: '', agenda: '', body: '', actions: ''
  })
  const [attendees, setAttendees] = useState<string[]>([])

  const original = {
    form: {
      title: meeting?.title ?? '',
      occurredOn: meeting?.occurredOn ?? todayStr(),
      startsAt: meeting?.startsAt ?? '',
      location: meeting?.location ?? '',
      agenda: meeting?.agenda ?? '',
      body: meeting?.body ?? '',
      actions: meeting?.actions ?? ''
    },
    attendees: [...(meeting ? meeting.attendees.map((a) => a.id) : cast.map((c) => c.personId))].sort()
  }

  useEffect(() => {
    if (!open) return
    setForm({
      title: meeting?.title ?? '',
      occurredOn: meeting?.occurredOn ?? todayStr(),
      startsAt: meeting?.startsAt ?? '',
      location: meeting?.location ?? '',
      agenda: meeting?.agenda ?? '',
      body: meeting?.body ?? '',
      actions: meeting?.actions ?? ''
    })
    // A new meeting starts with everyone on the project ticked; untick who was absent.
    setAttendees(meeting ? meeting.attendees.map((a) => a.id) : cast.map((c) => c.personId))
  }, [open, meeting, cast])

  const set = (key: keyof typeof form, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const toggle = (personId: string): void =>
    setAttendees((list) =>
      list.includes(personId) ? list.filter((id) => id !== personId) : [...list, personId]
    )

  const submit = async (): Promise<void> => {
    if (!form.title.trim() && !form.body.trim()) return
    await save.mutateAsync({ id: meeting?.id, projectId, ...form, attendeeIds: attendees })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={meeting ? 'Meeting' : 'Log a meeting'}
      width="max-w-2xl"
      onSubmit={() => void submit()}
      isDirty={differs({ form, attendees: [...attendees].sort() }, original)}
      footer={
        <>
          {meeting && (
            <ConfirmButton
              label="Delete"
              className="btn btn-ghost btn-sm mr-auto text-base-content/50 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: meeting.id })
                onClose()
              }}
            />
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
        <Field label="What was it">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Weekly sync, steering committee, client call…"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Date">
            <DateField value={form.occurredOn} onChange={(v) => set('occurredOn', v)} allowClear={false} />
          </Field>
          <Field label="Time">
            <input
              type="time"
              className="input input-bordered w-full"
              value={form.startsAt}
              onChange={(e) => set('startsAt', e.target.value)}
            />
          </Field>
          <Field label="Where">
            <input
              className="input input-bordered w-full"
              placeholder="Room 4, Meet…"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Who was there" hint="Everyone on the project starts ticked — untick whoever was absent.">
          {cast.length === 0 ? (
            <p className="text-[12px] text-base-content/40">
              Nobody on this project yet. Add people first and they will appear here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {cast.map((member) => {
                const on = attendees.includes(member.personId)
                return (
                  <button
                    key={member.personId}
                    type="button"
                    onClick={() => toggle(member.personId)}
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
        </Field>

        <Field label="Agenda">
          <textarea
            className="textarea textarea-bordered min-h-16 w-full text-sm leading-relaxed"
            value={form.agenda}
            onChange={(e) => set('agenda', e.target.value)}
          />
        </Field>

        <Field label="Notes">
          <textarea
            className="textarea textarea-bordered min-h-32 w-full text-sm leading-relaxed"
            placeholder="What was actually said, including the part that was awkward."
            value={form.body}
            onChange={(e) => set('body', e.target.value)}
          />
        </Field>

        <Field label="Actions" hint="One per line. These are what you will look for when you come back.">
          <textarea
            className="textarea textarea-bordered min-h-20 w-full text-sm leading-relaxed"
            value={form.actions}
            onChange={(e) => set('actions', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
