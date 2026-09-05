import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TaskView } from '@shared/types'
import { useApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { formatLongDate, plural, projectColor } from '@/lib/format'
import { Dot, EmptyState, PageHeader, Panel, Section } from '@/components/primitives'
import { Icon } from '@/components/Icon'
import { TaskDialog } from '@/components/TaskDialog'
import { TaskList } from '@/components/TaskRow'
import { Pending } from '@/components/PageTransition'
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

  return (
    <>
      <PageHeader
        title={formatLongDate(data.today)}
        subtitle={
          unstarted ? (
            <span>Nothing in {workspace.name} yet.</span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>{plural(data.stats.activeProjects, 'active project')}</span>
              <span>{plural(data.stats.openTasks, 'open item')}</span>
              <span>{plural(data.stats.peopleTracked, 'person', 'people')}</span>
            </span>
          )
        }
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

          <div
            className={`grid gap-x-10 ${
              // The rail only reserves its column when it has something in it —
              // otherwise every list on the page was narrowed for an empty gutter.
              data.needsAttention.length > 0 ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''
            }`}
          >
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

              {data.soon.length > 0 && (
                <Section title="Next seven days" count={data.soon.length}>
                  <TaskList tasks={data.soon} showProject onEdit={setEditing} />
                </Section>
              )}
            </div>

            <div>
              {data.needsAttention.length > 0 && (
                <Section title="Needs a look">
                  <Panel padded={false}>
                    {data.needsAttention.map((project) => (
                      <Link
                        key={project.id}
                        to={`/projects/${project.id}`}
                        className="row-hover hairline block border-b px-3 py-2.5 last:border-b-0"
                      >
                        <span className="flex items-center gap-2">
                          <Dot color={projectColor(project)} />
                          <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
                        </span>
                        <span className="mt-0.5 block pl-[15px] text-[11px] leading-snug text-base-content/45">
                          {project.attention}
                        </span>
                      </Link>
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
