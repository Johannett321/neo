import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TaskView } from '@shared/types'
import { formatDate, plural, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { Avatar, Panel, Section } from '@/components/primitives'
import { TaskDialog } from '@/components/TaskDialog'
import { TaskList } from '@/components/TaskRow'
import { LinksPanel } from '@/components/project/LinksPanel'
import { LogPanel } from '@/components/project/LogPanel'
import { ReentryBrief } from '@/components/project/ReentryBrief'
import { Standing } from '@/components/project/Standing'
import { useProject } from './ProjectLayout'

/** Soonest first, so a list of dated work reads in the order it will bite. */
const byDue = (a: TaskView, b: TaskView): number => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0)

/**
 * A project's Today: where were we, what is it asking for, and what is due. The
 * board, the meetings and the rest are one click away in the sidebar; this is the
 * page you read for thirty seconds after three weeks away.
 *
 * Read top to bottom it is one argument: what changed while you were gone, where the
 * project stands in a sentence, the work that is actually late or due, what a meeting
 * left owing, and then the log. Everything that is reference rather than news — the
 * links, the cast, the activity feed — is in the rail at rail weight.
 */
export function ProjectToday(): React.JSX.Element {
  const { project, brief, cast, links, journal, activity, meetings, columns, tasks } = useProject()
  const [editing, setEditing] = useState<TaskView | null>(null)

  /*
   * The dated work, split the same way the workspace's Today splits it — same
   * headings, same rows, same order — so the two screens read as one habit rather
   * than as two dashboards that happen to share a codebase. Undated open items are
   * not here on purpose: nothing calls them late, and the board is where they live.
   */
  const open = tasks.filter((t) => t.status === 'open')
  const overdue = open.filter((t) => t.daysUntilDue !== null && t.daysUntilDue < 0).sort(byDue)
  const dueToday = open.filter((t) => t.daysUntilDue === 0).sort(byDue)
  const soon = open
    .filter((t) => t.daysUntilDue !== null && t.daysUntilDue > 0 && t.daysUntilDue <= 7)
    .sort(byDue)

  // Agreed in a room and never closed. Nothing else on this page would ever raise it:
  // it is not a card, so no board holds it, and it carries no date, so nothing calls
  // it late.
  const owed = meetings.reduce((total, m) => total + m.openTodos, 0)
  const owingMeetings = meetings.filter((m) => m.openTodos > 0)

  return (
    <>
      {project.summary && (
        <p className="-mt-3 mb-7 max-w-2xl text-[13px] leading-relaxed text-base-content/55">
          {project.summary}
        </p>
      )}

      <ReentryBrief brief={brief} />

      <Standing
        project={project}
        open={open.length}
        overdue={overdue.length}
        owed={owed}
        hasMeetings={meetings.length > 0}
      />

      <div className="grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0">
          {overdue.length > 0 && (
            <Section title="Overdue" count={overdue.length} tone="danger">
              <TaskList tasks={overdue} onEdit={setEditing} />
            </Section>
          )}

          {dueToday.length > 0 && (
            <Section title="Due today" count={dueToday.length}>
              <TaskList tasks={dueToday} onEdit={setEditing} />
            </Section>
          )}

          {soon.length > 0 && (
            <Section title="Next seven days" count={soon.length}>
              <TaskList tasks={soon} onEdit={setEditing} />
            </Section>
          )}

          {owingMeetings.length > 0 && (
            <Section title="Still owed from meetings" count={owed} tone="danger">
              <Panel padded={false}>
                {owingMeetings.map((meeting) => (
                  <Link
                    key={meeting.id}
                    to={`/projects/${project.id}/meetings/${meeting.id}`}
                    className="row-hover hairline group flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                  >
                    <span className="owing-soft flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums">
                      {meeting.openTodos}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{meeting.title || 'Meeting'}</span>
                      <span className="mt-0.5 block text-[11px] text-base-content/45">
                        {formatDate(meeting.occurredOn)} ·{' '}
                        {plural(meeting.openTodos, 'open to-do', 'open to-dos')}
                      </span>
                    </span>
                    <Icon
                      name="chevronRight"
                      size={13}
                      className="shrink-0 text-base-content/25 opacity-0 transition group-hover:opacity-100"
                    />
                  </Link>
                ))}
              </Panel>
            </Section>
          )}

          <LogPanel projectId={project.id} entries={journal} />
        </div>

        <div className="min-w-0">
          <LinksPanel projectId={project.id} links={links} />

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
              <div>
                {/*
                  One line per person rather than two: the name and the hat they wear
                  are the whole answer to "who is on this", and the rail is not the
                  place to spend six rows on it. The People tab has the rest.
                */}
                {cast.slice(0, 5).map((member) => (
                  <Link
                    key={member.id}
                    to={`/people/${member.personId}`}
                    className="row-hover -mx-2 flex items-center gap-2.5 rounded-field px-2 py-1.5"
                  >
                    <Avatar
                      name={member.name}
                      color={member.avatarColor}
                      image={member.avatar}
                      size={20}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{member.name}</span>
                    {member.role && (
                      /*
                        The first hat only. Roles are free text and often a list of
                        them, and a rail this narrow truncates the second one mid-word;
                        the primary role is the answer to "who is this" and the People
                        tab carries the rest.
                      */
                      <span className="max-w-[46%] shrink-0 truncate text-[11px] text-base-content/40">
                        {member.role.split(',')[0]?.trim()}
                      </span>
                    )}
                  </Link>
                ))}
                {cast.length > 5 && (
                  <Link
                    to={`/projects/${project.id}/people`}
                    className="mt-1 block px-0.5 text-[11px] text-base-content/40 transition hover:text-base-content/70"
                  >
                    and {plural(cast.length - 5, 'other')}
                  </Link>
                )}
              </div>
            )}
          </Section>

          {/*
            The quietest thing on the page, and it should be. Anything here worth
            knowing has already been said by the re-entry brief above or by the log;
            this is only the trail underneath, so it gets no panel and the smallest
            type on the screen.
          */}
          {activity.length > 0 && (
            <Section title="Recent activity">
              <div className="space-y-1.5">
                {activity.slice(0, 6).map((item) => (
                  <div key={item.id} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-base-content/50">
                      {item.summary}
                    </span>
                    <span className="shrink-0 text-[10px] text-base-content/30">
                      {relativeFromIso(item.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>

      <TaskDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        task={editing}
        columns={columns}
      />
    </>
  )
}
