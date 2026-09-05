import { Link, useNavigate } from 'react-router-dom'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import { formatDate, plural } from '@/lib/format'
import { excerpt } from '@/lib/markdown'
import { Icon } from '@/components/Icon'
import { Avatar, EmptyState } from '@/components/primitives'
import { useProject } from './ProjectLayout'

/**
 * A meeting is a note that knows when it happened and who was there. That is the
 * difference that matters: months later the question is never "what was written",
 * it is "who was in the room when we agreed this".
 *
 * The list is an index rather than an editor — a meeting opens on its own page, the
 * same way a note does. What it has to answer without being opened is whether the
 * meeting left anything behind, so an unfinished item is said in words on the row.
 */
export function ProjectMeetings(): React.JSX.Element {
  const { project, meetings } = useProject()
  const remove = useApiMutation('meeting:delete')
  const openMenu = useContextMenu()
  const navigate = useNavigate()
  const href = (meetingId: string): string => `/projects/${project.id}/meetings/${meetingId}`

  const last = meetings[0]
  const owing = meetings.reduce((total, m) => total + m.openTodos, 0)

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link className="btn btn-primary btn-sm gap-1.5" to={href('new')}>
          <Icon name="plus" size={13} />
          Log a meeting
        </Link>
        {last && (
          <span className="text-[11px] text-base-content/40">
            Last one {formatDate(last.occurredOn)} · {plural(last.attendees.length, 'person', 'people')}
            {owing > 0 && ` · ${owing} still to do across all of them`}
          </span>
        )}
      </div>

      {meetings.length === 0 ? (
        <EmptyState
          icon="people"
          title="No meetings recorded."
          hint="Who was there, what was said and what came out of it. Five minutes afterwards saves an hour later."
        />
      ) : (
        <div className="space-y-2.5">
          {meetings.map((meeting) => (
            <Link
              key={meeting.id}
              to={href(meeting.id)}
              className="hairline row-hover block w-full rounded-box border bg-base-100 px-4 py-3 text-left"
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Open', icon: 'edit', onSelect: () => navigate(href(meeting.id)) },
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
                {meeting.openTodos > 0 && (
                  <span className="hairline flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[10.5px] text-base-content/70">
                    <Icon name="checkbox" size={10} />
                    {meeting.openTodos} still to do
                  </span>
                )}
                <span className="shrink-0 text-[11px] tabular-nums text-base-content/45">
                  {formatDate(meeting.occurredOn)}
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
                {meeting.todos.length > 0 && meeting.openTodos === 0 && (
                  <span className="text-[11px] text-base-content/35">
                    {plural(meeting.todos.length, 'item')}, all done
                  </span>
                )}
              </div>

              {meeting.body && (
                <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-base-content/60">
                  {excerpt(meeting.body)}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
