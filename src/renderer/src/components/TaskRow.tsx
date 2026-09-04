import { Link, useNavigate } from 'react-router-dom'
import { useContextMenu } from '@/lib/contextMenu'
import type { TaskView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { dueLabel, formatDate, KIND_LABEL } from '@/lib/format'
import { Avatar, Dot } from './primitives'
import { Icon } from './Icon'

const KIND_ICON = { task: 'check', delegated: 'arrowRight' } as const

/**
 * One row shape, used by Today, the project page, review and search. Reusing it
 * everywhere is what makes different screens feel like the same application.
 */
export function TaskRow({
  task,
  showProject = false,
  onEdit
}: {
  task: TaskView
  showProject?: boolean
  onEdit?: (task: TaskView) => void
}): React.JSX.Element {
  const setStatus = useApiMutation('task:setStatus')
  const remove = useApiMutation('task:delete')
  const navigate = useNavigate()
  const openMenu = useContextMenu()
  const done = task.status === 'done'
  const overdue = task.daysUntilDue !== null && task.daysUntilDue < 0 && !done
  const dueToday = task.daysUntilDue === 0 && !done

  return (
    <div
      onContextMenu={(e) =>
        openMenu(e, [
          {
            label: done ? 'Mark as not done' : 'Mark as done',
            icon: 'check',
            onSelect: () => setStatus.mutate({ id: task.id, status: done ? 'open' : 'done' })
          },
          { label: 'Edit…', icon: 'edit', disabled: !onEdit, onSelect: () => onEdit?.(task) },
          {
            label: 'Open project',
            icon: 'projects',
            onSelect: () => navigate(`/projects/${task.projectId}`)
          },
          'separator',
          {
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: () => remove.mutate({ id: task.id }),
            confirm: { title: 'Delete this item?', body: task.title }
          }
        ])
      }
      className="row-hover hairline group flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
      style={showProject ? { boxShadow: `inset 2px 0 0 ${task.workspaceColor}` } : undefined}
    >
      <button
          className="flex size-[18px] items-center justify-center rounded-[5px] border border-base-content/25 text-transparent transition hover:border-primary hover:text-primary/50 data-[done=true]:border-primary data-[done=true]:bg-primary data-[done=true]:text-primary-content"
          data-done={done}
          onClick={() => setStatus.mutate({ id: task.id, status: done ? 'open' : 'done' })}
          aria-label={done ? 'Mark as open' : 'Mark as done'}
        >
        <Icon name="check" size={11} strokeWidth={2.4} />
      </button>

      <button
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        onClick={() => onEdit?.(task)}
      >
        <span className={`truncate text-sm ${done ? 'text-base-content/35 line-through' : ''}`}>
          {task.title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-base-content/45">
          {showProject && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Dot color={task.workspaceColor} size={5} />
              <span className="truncate">{task.projectName}</span>
            </span>
          )}
          {task.laneName && <span className="truncate">{task.laneName}</span>}
          {task.kind !== 'task' && (
            <span className="flex items-center gap-1">
              <Icon name={KIND_ICON[task.kind]} size={10} />
              {KIND_LABEL[task.kind]}
            </span>
          )}
        </span>
      </button>

      {task.assigneeName && (
        <span className="shrink-0" title={`Assigned to ${task.assigneeIsMe ? 'you' : task.assigneeName}`}>
          <Avatar
            name={task.assigneeName}
            color={task.assigneeColor ?? '#64748b'}
            image={task.assigneeAvatar}
            size={20}
          />
        </span>
      )}

      {task.dueDate && (
        <span
          className={`shrink-0 text-xs tabular-nums ${
            overdue ? 'font-medium text-error' : dueToday ? 'font-medium text-warning' : 'text-base-content/40'
          }`}
          title={formatDate(task.dueDate)}
        >
          {dueLabel(task.daysUntilDue)}
        </span>
      )}

      {showProject && (
        <Link
          to={`/projects/${task.projectId}`}
          className="btn btn-ghost btn-xs btn-circle opacity-0 transition group-hover:opacity-100"
          aria-label="Open project"
        >
          <Icon name="chevronRight" size={13} />
        </Link>
      )}
    </div>
  )
}

export function TaskList({
  tasks,
  showProject = false,
  onEdit
}: {
  tasks: TaskView[]
  showProject?: boolean
  onEdit?: (task: TaskView) => void
}): React.JSX.Element {
  return (
    <div className="hairline overflow-hidden rounded-box border bg-base-100">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} showProject={showProject} onEdit={onEdit} />
      ))}
    </div>
  )
}
