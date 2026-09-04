import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TaskView } from '@shared/types'
import { useApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { formatLongDate, plural } from '@/lib/format'
import { EmptyState, HealthDot, PageHeader, Panel, Section } from '@/components/primitives'
import { TaskDialog } from '@/components/TaskDialog'
import { TaskList } from '@/components/TaskRow'

export function TodayPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const { data, isLoading } = useApi('dashboard:today', { workspaceId: workspace.id })
  const [editing, setEditing] = useState<TaskView | null>(null)

  if (isLoading || !data) return <div className="py-20 text-center text-sm text-base-content/40">Loading…</div>

  const clear = data.overdue.length === 0 && data.dueToday.length === 0 && data.soon.length === 0

  return (
    <>
      <PageHeader
        title={formatLongDate(data.today)}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{plural(data.stats.activeProjects, 'active project')}</span>
            <span>{plural(data.stats.openTasks, 'open item')}</span>
            <span>{plural(data.stats.peopleTracked, 'person', 'people')}</span>
          </span>
        }
      />

      {clear && (
        <div className="mb-9">
          <EmptyState
            icon="check"
            title="Nothing is due and nothing is stuck."
            hint="No overdue items and nothing due in the next week. Look at the horizon, or go and do the work."
          />
        </div>
      )}

      <div className="grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_320px]">
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

          {data.overdue.length === 0 && data.dueToday.length === 0 && data.soon.length === 0 && !clear && (
            <Section title="Due">
              <EmptyState icon="check" title="Nothing due in the next week." />
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
                      <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
                      <HealthDot health={project.health} />
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-base-content/45">
                      {project.health.reasons[0]}
                    </span>
                  </Link>
                ))}
              </Panel>
            </Section>
          )}
        </div>
      </div>

      <TaskDialog open={editing !== null} onClose={() => setEditing(null)} task={editing} />
    </>
  )
}
