import { useEffect, useState } from 'react'
import { Outlet, useOutletContext, useParams } from 'react-router-dom'
import type { ProjectDetail } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { formatDate, relativeFromIso, STATUS_LABEL } from '@/lib/format'
import { RoleBadges } from '@/components/RoleInput'
import { Icon } from '@/components/Icon'
import { HealthDot } from '@/components/primitives'

/** Child routes read the project through the outlet, so it is fetched once. */
export const useProject = (): ProjectDetail => useOutletContext<ProjectDetail>()

export function ProjectLayout(): React.JSX.Element {
  const { id = '' } = useParams()
  const { data, isLoading } = useApi('project:get', { id })
  const save = useApiMutation('project:save')
  const setArchived = useApiMutation('project:setArchived')

  const [name, setName] = useState('')

  useEffect(() => {
    if (data) setName(data.project.name)
  }, [data?.project.id, data?.project.name])

  if (isLoading || !data) {
    return <div className="py-20 text-center text-sm text-base-content/40">Loading…</div>
  }

  const { project } = data

  return (
    <>
      <div className="mb-7 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <input
            className="quiet-input -mx-2 w-full px-2 py-1 text-[26px] font-semibold tracking-[-0.02em]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== project.name && save.mutate({ id: project.id, name: name.trim() })}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-base-content/50">
            <HealthDot health={project.health} showLabel />
            <RoleBadges value={project.myRoles} />
            {project.status !== 'active' && (
              <span className="hairline rounded-full border px-1.5 py-px text-[10px]">
                {STATUS_LABEL[project.status]}
              </span>
            )}
            <span>Touched {relativeFromIso(project.lastActivityAt)}</span>
            {project.deadline && (
              <span className="flex items-center gap-1 font-medium">
                <Icon name="flag" size={11} />
                Deadline {formatDate(project.deadline)}
              </span>
            )}
            {project.nextDue && (
              <span className={project.overdueTasks > 0 ? 'text-error' : undefined}>
                Next due {formatDate(project.nextDue)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className={`btn btn-sm btn-circle ${project.isPinned ? 'btn-neutral' : 'btn-ghost text-base-content/40'}`}
            title={project.isPinned ? 'Unpin' : 'Pin to the top'}
            onClick={() => save.mutate({ id: project.id, isPinned: !project.isPinned })}
          >
            <Icon name="pin" size={14} />
          </button>
        </div>
      </div>

      {project.archivedAt && (
        <div className="hairline mb-6 flex items-center gap-3 rounded-box border bg-base-200/50 px-4 py-2.5">
          <Icon name="archive" size={15} className="text-base-content/40" />
          <span className="flex-1 text-[12px] text-base-content/60">
            This project is archived. It stays out of Today, the timeline, the review and search until
            you restore it.
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setArchived.mutate({ id: project.id, archived: false })}
          >
            Restore
          </button>
        </div>
      )}

      <Outlet context={data} />
    </>
  )
}
