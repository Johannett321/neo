import { Link, useNavigate } from 'react-router-dom'
import { useApiMutation } from '@/lib/api'
import { useContextMenu } from '@/lib/contextMenu'
import type { ProjectSummary } from '@shared/types'
import { daysBetween, dueLabel, formatDate, relativeFromIso, STATUS_LABEL, todayStr } from '@/lib/format'
import { RoleBadges } from './RoleInput'
import { Icon } from './Icon'
import { Mark } from './Mark'
import { HealthDot } from './primitives'

function Initial({
  name,
  color,
  image
}: {
  name: string
  color: string
  image: string | null
}): React.JSX.Element {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        title={name}
        className="size-[22px] shrink-0 rounded-full object-cover ring-2 ring-base-100"
      />
    )
  }
  return (
    <span
      className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[9px] font-medium text-white ring-2 ring-base-100"
      style={{ backgroundColor: color }}
      title={name}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * The card carries what a project manager checks before opening anything: is it in
 * trouble, what hat am I wearing, how much is open, when is the next date, and who
 * is on it. Everything else waits until you are inside.
 */
export function ProjectCard({ project }: { project: ProjectSummary }): React.JSX.Element {
  const navigate = useNavigate()
  const openMenu = useContextMenu()
  const save = useApiMutation('project:save')
  const setArchived = useApiMutation('project:setArchived')
  const remove = useApiMutation('project:delete')
  const dueIn = project.nextDue ? daysBetween(todayStr(), project.nextDue) : null
  const deadlineIn = project.deadline ? daysBetween(todayStr(), project.deadline) : null

  return (
    <Link
      to={`/projects/${project.id}`}
      className="hairline group flex flex-col rounded-box border bg-base-100 p-4 transition hover:border-base-content/20 hover:shadow-sm"
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Open', icon: 'arrowRight', onSelect: () => navigate(`/projects/${project.id}`) },
          { label: 'Open board', icon: 'lane', onSelect: () => navigate(`/projects/${project.id}/kanban`) },
          { label: 'Project settings', icon: 'settings', onSelect: () => navigate(`/projects/${project.id}/settings`) },
          'separator',
          {
            label: project.isPinned ? 'Unpin' : 'Pin to the top',
            icon: 'pin',
            onSelect: () => save.mutate({ id: project.id, isPinned: !project.isPinned })
          },
          {
            label: project.archivedAt ? 'Restore from archive' : 'Archive',
            icon: 'archive',
            onSelect: () => setArchived.mutate({ id: project.id, archived: !project.archivedAt })
          },
          'separator',
          {
            label: 'Delete project',
            icon: 'trash',
            danger: true,
            onSelect: () => remove.mutate({ id: project.id }),
            confirm: {
              title: `Delete ${project.name}?`,
              body: 'Its items, notes, meetings, decisions and log go with it. Archiving hides it instead, and keeps everything.',
              confirmLabel: 'Delete project'
            }
          }
        ])
      }
    >
      <div className="mb-2.5 flex items-start gap-3">
        <Mark
          name={project.name}
          color={project.workspaceColor}
          icon={project.icon}
          size={34}
          rounded="rounded-[9px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {project.isPinned && <Icon name="pin" size={11} className="shrink-0 text-base-content/30" />}
            <span className="truncate text-[14px] font-medium tracking-[-0.01em]">{project.name}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-base-content/45">
            <RoleBadges value={project.myRoles} />
            {project.status !== 'active' && (
              <span className="hairline rounded-full border px-1.5 py-px text-[10px]">
                {STATUS_LABEL[project.status]}
              </span>
            )}
          </div>
        </div>
        <HealthDot health={project.health} />
      </div>

      {project.deadline && deadlineIn !== null && (
        <div
          className={`mb-2 flex items-center gap-1.5 rounded-field px-2 py-1 text-[11px] ${
            deadlineIn < 0
              ? 'bg-error/10 text-error'
              : deadlineIn <= 14
                ? 'bg-warning/12 text-warning'
                : 'bg-base-content/[0.05] text-base-content/55'
          }`}
        >
          <Icon name="flag" size={11} />
          <span className="font-medium">Deadline {formatDate(project.deadline)}</span>
          <span className="opacity-70">· {dueLabel(deadlineIn)}</span>
        </div>
      )}

      <p className="line-clamp-2 min-h-[2.4em] text-[12px] leading-[1.45] text-base-content/60">
        {project.summary || project.currentState || 'No summary yet.'}
      </p>

      {project.nextAction ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-base-content/50">
          <Icon name="arrowRight" size={11} className="mt-[3px] shrink-0 opacity-60" />
          <span className="line-clamp-1">{project.nextAction}</span>
        </p>
      ) : (
        <p className="mt-2 text-[11px] leading-snug text-warning/80">No next action</p>
      )}

      <div className="hairline mt-3 flex items-center gap-2 border-t pt-2.5">
        {project.castPreview.length > 0 ? (
          <span className="flex -space-x-1.5">
            {project.castPreview.slice(0, 4).map((member) => (
              <Initial key={member.name} name={member.name} color={member.color} image={member.avatar} />
            ))}
            {project.peopleCount > 4 && (
              <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-base-300 text-[9px] font-medium text-base-content/60 ring-2 ring-base-100">
                +{project.peopleCount - 4}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[11px] text-base-content/30">No people yet</span>
        )}

        <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums">
          {project.overdueTasks > 0 ? (
            <span className="font-medium text-error">{project.overdueTasks} overdue</span>
          ) : (
            <span className="text-base-content/45">{project.openTasks} open</span>
          )}
          <span className="text-base-content/35">{relativeFromIso(project.lastActivityAt)}</span>
          {dueIn !== null && (
            <span
              className={
                dueIn < 0 ? 'text-error' : dueIn <= 2 ? 'text-warning' : 'text-base-content/45'
              }
              title={project.nextDue ?? undefined}
            >
              {dueLabel(dueIn)}
            </span>
          )}
        </span>
      </div>

    </Link>
  )
}
