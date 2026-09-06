import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProjectDetail, ProjectStatus } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { projectColor, ROLE_SUGGESTIONS, STATUS_LABEL } from '@/lib/format'
import { formatRoles, parseRoles, RoleInput } from '@/components/RoleInput'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { IconPicker } from '@/components/IconPicker'
import { SettingsLayout } from '@/components/SettingsLayout'
import { ConfirmButton, Field, Panel } from '@/components/primitives'
import { PROJECT_COLORS } from '@/components/WorkspaceModal'
import { useProject } from './ProjectLayout'

type Project = ProjectDetail['project']

/**
 * Everything about the project rather than in it. The pages either side of this one
 * are for doing the work; this is where the project's own shape gets changed, which
 * is rare enough that it does not belong in a header you look at all day.
 */
export function ProjectSettings(): React.JSX.Element {
  const { project, tasks } = useProject()

  return (
    <SettingsLayout
      exitTo={`/projects/${project.id}`}
      panes={[
        {
          id: 'identity',
          label: 'Identity',
          icon: 'sparkle',
          description: 'How the project appears in the grid and the sidebar.',
          render: () => <IdentityPane project={project} />
        },
        {
          id: 'work',
          label: 'How you work on it',
          icon: 'board',
          description: 'Your hat here, and how the project is counted.',
          render: () => <WorkPane project={project} />
        },
        {
          id: 'archive',
          label: 'Archive and delete',
          icon: 'archive',
          tone: 'warn',
          render: () => <DangerPane project={project} taskCount={tasks.length} />
        }
      ]}
    />
  )
}

function IdentityPane({ project }: { project: Project }): React.JSX.Element {
  const save = useApiMutation('project:save')
  const [name, setName] = useState(project.name)
  const [summary, setSummary] = useState(project.summary)

  useEffect(() => {
    setName(project.name)
    setSummary(project.summary)
  }, [project.id, project.name, project.summary])

  return (
    <Panel>
      <IconPicker
        name={project.name}
        color={projectColor(project)}
        icon={project.icon}
        hint="Shown on the project card and in the sidebar. Without one, the initial is used."
        onChange={({ iconPath }) => save.mutate({ id: project.id, iconPath })}
      />

      <div className="mt-5 space-y-4">
        <Field label="Name">
          <input
            className="input input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() && name !== project.name && save.mutate({ id: project.id, name: name.trim() })
            }
          />
        </Field>
        <Field label="One line about it" hint="The line that appears on the project card.">
          <input
            className="input input-bordered w-full"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => summary !== project.summary && save.mutate({ id: project.id, summary })}
          />
        </Field>
        <Field
          label="Colour"
          hint="How you pick this project out of the grid. Left unset it takes its workspace's colour."
        >
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              type="button"
              title="Use the workspace colour"
              aria-label="Use the workspace colour"
              className={`hairline size-7 rounded-full border border-dashed transition ${
                project.color === ''
                  ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100'
                  : 'opacity-60 hover:opacity-100'
              }`}
              onClick={() => project.color !== '' && save.mutate({ id: project.id, color: '' })}
            />
            {PROJECT_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                className={`size-7 rounded-full transition ${
                  project.color === swatch
                    ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100'
                    : ''
                }`}
                style={{ backgroundColor: swatch }}
                onClick={() => save.mutate({ id: project.id, color: swatch })}
              />
            ))}
          </div>
        </Field>
        <Field
          label="Deadline"
          hint="The date the whole project has to land. It shows on the card, and puts the project on Today's short list a fortnight out."
        >
          <DateField
            value={project.deadline ?? ''}
            onChange={(v) => save.mutate({ id: project.id, deadline: v || null })}
            placeholder="No deadline"
            className="w-56"
          />
        </Field>
        <Field
          label="Started"
          hint="The day the project actually began, which is rarely the day you added it here. The deadline bar measures its run-up from this date, so move it back and the bar tells the truth."
        >
          <DateField
            value={project.createdAt.slice(0, 10)}
            onChange={(v) => v && save.mutate({ id: project.id, createdAt: v })}
            className="w-56"
          />
        </Field>
      </div>
    </Panel>
  )
}

function WorkPane({ project }: { project: Project }): React.JSX.Element {
  const save = useApiMutation('project:save')
  const saveMine = useApiMutation('membership:saveMine')
  const usedRoles = useApi('membership:roles', { workspaceId: project.workspaceId })
  const suggestions = [...new Set([...(usedRoles.data ?? []), ...ROLE_SUGGESTIONS])]

  const [myRoles, setMyRoles] = useState(parseRoles(project.myRoles))

  useEffect(() => setMyRoles(parseRoles(project.myRoles)), [project.id, project.myRoles])

  return (
    <Panel>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="My roles here"
          hint="The hat, or hats, you wear on this project. The same list everyone else's roles come from."
        >
          <RoleInput
            roles={myRoles}
            suggestions={suggestions}
            onChange={(roles) => {
              setMyRoles(roles)
              saveMine.mutate({ projectId: project.id, role: formatRoles(roles) })
            }}
          />
        </Field>
        <Field
          label="Status"
          hint="Paused takes it off Today entirely. Dormant only stops it being counted as drifting."
        >
          <select
            className="select select-bordered w-full"
            value={project.status}
            onChange={(e) => save.mutate({ id: project.id, status: e.target.value as ProjectStatus })}
          >
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          className="checkbox checkbox-sm mt-0.5"
          checked={project.isPinned}
          onChange={(e) => save.mutate({ id: project.id, isPinned: e.target.checked })}
        />
        <span className="text-sm">
          Pin to the top
          <span className="block text-[11px] text-base-content/45">
            Keeps it first in the project grid, whatever else is happening.
          </span>
        </span>
      </label>
    </Panel>
  )
}

function DangerPane({
  project,
  taskCount
}: {
  project: Project
  taskCount: number
}): React.JSX.Element {
  const navigate = useNavigate()
  const setArchived = useApiMutation('project:setArchived')
  const remove = useApiMutation('project:delete')

  return (
    <Panel>
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="text-[13px] font-medium">
            {project.archivedAt ? 'Restore this project' : 'Archive this project'}
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            {project.archivedAt
              ? 'Bring it back into Today, the timeline, the weekly review and search.'
              : 'Puts it out of the way without losing anything — it leaves Today, the timeline, the review and search, and comes back in one click.'}
          </p>
        </div>
        <button
          className="btn btn-sm gap-1.5"
          onClick={async () => {
            await setArchived.mutateAsync({ id: project.id, archived: !project.archivedAt })
            if (!project.archivedAt) navigate('/projects')
          }}
        >
          <Icon name="archive" size={13} />
          {project.archivedAt ? 'Restore' : 'Archive'}
        </button>
      </div>

      <div className="hairline mt-4 flex items-start gap-4 border-t pt-4">
        <div className="flex-1">
          <div className="text-[13px] font-medium">Delete this project</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            Permanently removes its {taskCount} items, notes, meetings, decisions, journal and links.
            The people stay in the workspace. This cannot be undone.
          </p>
        </div>
        <ConfirmButton
          label="Delete"
          className="btn btn-sm text-base-content/60 hover:text-error"
          onConfirm={async () => {
            await remove.mutateAsync({ id: project.id })
            navigate('/projects')
          }}
        />
      </div>
    </Panel>
  )
}
