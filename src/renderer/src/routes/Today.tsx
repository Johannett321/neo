import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TaskView } from '@shared/types'
import { useApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { plural, projectColor } from '@/lib/format'
import { Dot, EmptyState, Panel, Section } from '@/components/primitives'
import { Icon } from '@/components/Icon'
import { TaskDialog } from '@/components/TaskDialog'
import { TaskList } from '@/components/TaskRow'
import { Pending } from '@/components/PageTransition'
import { TodayHero } from '@/components/today/TodayHero'
import { NewProjectModal } from './Projects'

export function TodayPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const { data, isLoading } = useApi('dashboard:today', { workspaceId: workspace.id })
  // The same key the sidebar warms on hover, so this is a cache read rather than a
  // second round trip. It answers a question the counts cannot: whether this
  // workspace is quiet or simply empty.
  const projects = useApi('project:list', { workspaceId: workspace.id, status: 'all', archived: false })
  const [editing, setEditing] = useState<TaskView | null>(null)
  const [creating, setCreating] = useState(false)

  if (isLoading || !data) return <Pending />

  const clear = data.overdue.length === 0 && data.dueToday.length === 0 && data.soon.length === 0
  /**
   * Nothing has ever been put in here — which is a different fact from having
   * nothing due, and needs the opposite screen. "Nothing is due and nothing is
   * stuck" congratulates someone who has not started, and the three zeroes under
   * the date say the same thing again in numbers. Neither tells them what to do.
   */
  const unstarted = projects.data !== undefined && projects.data.length === 0

  /*
   * What the rail carries is now partly a preference. It still only reserves its
   * column when it has something in it — otherwise every list on the page was
   * narrowed for an empty gutter — and switching both halves off is a way to get
   * the full width back deliberately.
   */
  const attention = workspace.todayShowAttention ? data.needsAttention : []
  const owed = workspace.todayShowMeetingTodos ? data.owedFromMeetings : []
  const soon = workspace.todayShowSoon ? data.soon : []
  const hasRail = attention.length > 0 || owed.length > 0

  return (
    <>
      <TodayHero
        workspace={workspace}
        today={data.today}
        stats={unstarted ? undefined : data.stats}
      />

      {unstarted ? (
        /*
         * The one screen in the app that cannot derive anything, because there is
         * nothing to derive it from. So it says what the next step is and offers it,
         * rather than describing what this screen will look like once it works.
         */
        <div className="hairline rounded-box border border-dashed px-8 py-12 text-center">
          <span className="inline-flex size-11 items-center justify-center rounded-[13px] bg-primary/10 text-primary">
            <Icon name="projects" size={21} />
          </span>
          <h2 className="mt-4 text-[17px] font-semibold tracking-[-0.015em]">
            Start with one project
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-base-content/55">
            Everything else hangs off one — the board, the people, the meetings, the log. A project
            is anything you would otherwise have to hold in your head: a team&rsquo;s workstream, a
            client engagement, a side of the business.
          </p>
          <button className="btn btn-primary btn-sm mt-5 gap-1.5" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Create your first project
          </button>
          <p className="mt-4 text-[11.5px] text-base-content/35">
            Then <kbd className="font-mono">⌘N</kbd> puts a task, a decision, a log entry or a
            meeting into it from anywhere.
          </p>
        </div>
      ) : (
        <>
          {clear && (
            <div className="mb-9">
              <EmptyState
                icon="check"
                title="Nothing is due and nothing is stuck."
                hint="No overdue items and nothing due in the next week. Look at the horizon, or go and do the work."
              />
            </div>
          )}

          <div className={`grid gap-x-10 ${hasRail ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
            <div>
              {data.overdue.length > 0 && (
                <Section title="Overdue" count={data.overdue.length} tone="danger">
                  <TaskList tasks={data.overdue} showProject onEdit={setEditing} />
                </Section>
              )}

              {data.dueToday.length > 0 && (
                <Section title="Due today" count={data.dueToday.length}>
                  <TaskList tasks={data.dueToday} showProject onEdit={setEditing} />
                </Section>
              )}

              {soon.length > 0 && (
                <Section title="Next seven days" count={soon.length}>
                  <TaskList tasks={soon} showProject onEdit={setEditing} />
                </Section>
              )}
            </div>

            <div>
              {attention.length > 0 && (
                <Section title="Needs a look">
                  <Panel padded={false}>
                    {attention.map((project) => (
                      <RailRow
                        key={project.id}
                        to={`/projects/${project.id}`}
                        color={projectColor(project)}
                        title={project.name}
                        detail={project.attention ?? ''}
                      />
                    ))}
                  </Panel>
                </Section>
              )}

              {/*
                Things a meeting left owing. They belong on this screen and nowhere
                else would put them here: a to-do agreed in a room is not a card, so
                no board holds it, and it carries no date, so no overdue list will
                ever call it late. Red because the whole point is that it is not
                closed — the same red the overdue list uses, for the same reason.
              */}
              {owed.length > 0 && (
                <Section
                  title="Open to-dos from meetings"
                  count={owed.reduce((total, m) => total + m.openTodos, 0)}
                  tone="danger"
                >
                  <Panel padded={false}>
                    {owed.map((meeting) => (
                      <RailRow
                        key={meeting.meetingId}
                        to={`/projects/${meeting.projectId}/meetings/${meeting.meetingId}`}
                        color={projectColor({
                          projectColor: meeting.projectColor,
                          workspaceColor: workspace.color
                        })}
                        title={meeting.title || 'Meeting'}
                        detail={`${meeting.projectName} · ${plural(meeting.openTodos, 'open to-do', 'open to-dos')}`}
                        badge={meeting.openTodos}
                      />
                    ))}
                  </Panel>
                </Section>
              )}
            </div>
          </div>
        </>
      )}

      <TaskDialog open={editing !== null} onClose={() => setEditing(null)} task={editing} />
      <NewProjectModal open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

/**
 * One row in the rail down the right. Both lists in it are the same shape — a thing
 * with a colour, a name and one line saying why it is here — so they are one
 * component, and the chevron that appears under the pointer says the row goes
 * somewhere without adding a control to every row that does not.
 */
function RailRow({
  to,
  color,
  title,
  detail,
  badge
}: {
  to: string
  color: string
  title: string
  detail: string
  badge?: number
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className="row-hover hairline group block border-b px-3 py-2.5 last:border-b-0"
    >
      <span className="flex items-center gap-2">
        <Dot color={color} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
        {badge !== undefined && (
          <span className="shrink-0 rounded-full bg-error/12 px-1.5 py-px text-[10px] font-medium tabular-nums text-error">
            {badge}
          </span>
        )}
        <Icon
          name="chevronRight"
          size={13}
          className="shrink-0 text-base-content/30 opacity-0 transition group-hover:opacity-100"
        />
      </span>
      <span className="mt-0.5 block pl-[15px] text-[11px] leading-snug text-base-content/45">
        {detail}
      </span>
    </Link>
  )
}
