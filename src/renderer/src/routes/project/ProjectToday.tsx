import { Link } from 'react-router-dom'
import { formatDate, plural, relativeFromIso } from '@/lib/format'
import { DeadlineBar } from '@/components/DeadlineBar'
import { Icon } from '@/components/Icon'
import { Avatar, Panel, Section } from '@/components/primitives'
import { RoleBadges } from '@/components/RoleInput'
import { JournalTab } from '@/components/project/JournalTab'
import { LinksPanel } from '@/components/project/LinksPanel'
import { ReentryBrief } from '@/components/project/ReentryBrief'
import { useProject } from './ProjectLayout'

/**
 * A project's Today: where were we, and what is the state of it right now. The board,
 * the meetings and the rest are one click away in the sidebar; this is the page you
 * read for thirty seconds after three weeks away.
 */
export function ProjectToday(): React.JSX.Element {
  const { project, brief, cast, links, journal, activity, meetings } = useProject()
  const lastMeeting = meetings[0]
  // Agreed in a room and never closed. Nothing else on this page would ever raise it:
  // it is not a card, so no board holds it, and it carries no date, so nothing calls
  // it late.
  const owing = meetings.reduce((total, m) => total + m.openTodos, 0)
  const owingMeetings = meetings.filter((m) => m.openTodos > 0)

  return (
    <>
      <ReentryBrief brief={brief} />

      <div className="grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <Section title="Log" count={journal.length}>
            <JournalTab projectId={project.id} entries={journal.slice(0, 8)} />
          </Section>
        </div>

        <div className="min-w-0">
          {owingMeetings.length > 0 && (
            <Section title="Open to-dos from meetings" count={owing} tone="danger">
              <Panel padded={false}>
                {owingMeetings.map((meeting) => (
                  <Link
                    key={meeting.id}
                    to={`/projects/${project.id}/meetings/${meeting.id}`}
                    className="row-hover hairline block border-b px-3 py-2.5 last:border-b-0"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {meeting.title || 'Meeting'}
                      </span>
                      <span className="owing-text shrink-0 text-[11px] font-medium tabular-nums">
                        {meeting.openTodos}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-base-content/45">
                      {formatDate(meeting.occurredOn)} ·{' '}
                      {plural(meeting.openTodos, 'open to-do', 'open to-dos')}
                    </span>
                  </Link>
                ))}
              </Panel>
            </Section>
          )}

          {/*
            How much of the run-up has gone, measured from the day the project was
            created rather than from nothing — the same bar the project cards carry,
            so the answer does not change depending on which screen you read it from.
            A project with no deadline has no run-up, and gets no bar rather than an
            empty one.
          */}
          {project.deadline && (
            <Section title="Progress">
              <Panel>
                <DeadlineBar
                  deadline={project.deadline}
                  createdAt={project.createdAt}
                  color={project.color || project.workspaceColor}
                />
                <p className="mt-2 text-[11px] text-base-content/45">
                  Since {formatDate(project.createdAt.slice(0, 10))}
                </p>
              </Panel>
            </Section>
          )}

          <LinksPanel projectId={project.id} links={links} />

          <Section title="At a glance">
            <Panel>
              <dl className="space-y-2 text-[12px]">
                {[
                  ['Deadline', project.deadline ? formatDate(project.deadline) : 'None set'],
                  ['Overdue', project.overdueTasks > 0 ? `${project.overdueTasks}` : 'None'],
                  ['Next due', project.nextDue ? formatDate(project.nextDue) : 'Nothing dated'],
                  ['Last meeting', lastMeeting ? formatDate(lastMeeting.occurredOn) : 'None recorded'],
                  ['Last opened', relativeFromIso(project.previousOpenedAt ?? project.lastOpenedAt)]
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-base-content/45">{label}</dt>
                    <dd
                      className={`truncate text-right ${
                        label === 'Overdue' && project.overdueTasks > 0
                          ? 'font-medium text-error'
                          : ''
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </Section>

          <Section
            title="Cast"
            count={cast.length}
            action={
              <Link to={`/projects/${project.id}/people`} className="btn btn-ghost btn-xs gap-1">
                Manage
                <Icon name="chevronRight" size={11} />
              </Link>
            }
          >
            {cast.length === 0 ? (
              <Link
                to={`/projects/${project.id}/people`}
                className="hairline block rounded-box border border-dashed px-3 py-3 text-center text-[12px] text-base-content/45"
              >
                Nobody recorded yet — add the cast
              </Link>
            ) : (
              <Panel padded={false}>
                {cast.slice(0, 6).map((member) => (
                  <Link
                    key={member.id}
                    to={`/people/${member.personId}`}
                    className="row-hover hairline flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0"
                  >
                    <Avatar
                      name={member.name}
                      color={member.avatarColor}
                      image={member.avatar}
                      size={22}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{member.name}</span>
                      <RoleBadges value={member.role} className="mt-0.5" />
                    </span>
                  </Link>
                ))}
                {cast.length > 6 && (
                  <div className="px-3 py-2 text-[11px] text-base-content/40">
                    and {plural(cast.length - 6, 'other')}
                  </div>
                )}
              </Panel>
            )}
          </Section>

          <Section title="Recent activity">
            <Panel padded={false}>
              {activity.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="hairline flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-base-content/60">
                    {item.summary}
                  </span>
                  <span className="shrink-0 text-[10px] text-base-content/35">
                    {relativeFromIso(item.createdAt)}
                  </span>
                </div>
              ))}
              {activity.length === 0 && (
                <div className="px-3 py-3 text-[11px] text-base-content/35">Nothing yet.</div>
              )}
            </Panel>
          </Section>
        </div>
      </div>
    </>
  )
}
