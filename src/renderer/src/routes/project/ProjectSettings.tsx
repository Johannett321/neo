import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProjectStatus } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { formatDate, relativeFromIso, ROLE_SUGGESTIONS, STATUS_LABEL } from '@/lib/format'
import { formatRoles, parseRoles, RoleInput } from '@/components/RoleInput'
import { Icon } from '@/components/Icon'
import { DateField } from '@/components/DateField'
import { IconPicker } from '@/components/IconPicker'
import { ConfirmButton, Field, Panel, Section } from '@/components/primitives'
import { useProject } from './ProjectLayout'

/**
 * Everything about the project rather than in it. The pages either side of this one
 * are for doing the work; this is where the project's own shape gets changed, which
 * is rare enough that it does not belong in a header you look at all day.
 */
export function ProjectSettings(): React.JSX.Element {
  const { project, lanes, tasks } = useProject()
  const navigate = useNavigate()
  const save = useApiMutation('project:save')
  const setArchived = useApiMutation('project:setArchived')
  const remove = useApiMutation('project:delete')

  const [name, setName] = useState(project.name)
  const [summary, setSummary] = useState(project.summary)
  const [myRoles, setMyRoles] = useState(parseRoles(project.myRoles))

  const saveMine = useApiMutation('membership:saveMine')
  const usedRoles = useApi('membership:roles', { workspaceId: project.workspaceId })
  const suggestions = [...new Set([...(usedRoles.data ?? []), ...ROLE_SUGGESTIONS])]

  useEffect(() => {
    setName(project.name)
    setSummary(project.summary)
    setMyRoles(parseRoles(project.myRoles))
  }, [project.id, project.name, project.summary, project.myRoles])

  return (
    <div className="max-w-2xl">
      <Section title="Identity">
        <Panel>
          <IconPicker
            name={project.name}
            color={project.workspaceColor}
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
              label="Deadline"
              hint="The date the whole project has to land. It shows on the card and starts counting against health two weeks out."
            >
              <DateField
                value={project.deadline ?? ''}
                onChange={(v) => save.mutate({ id: project.id, deadline: v || null })}
                placeholder="No deadline"
                className="w-56"
              />
            </Field>
          </div>
        </Panel>
      </Section>

      <Section title="How you work on it">
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
            <Field label="Status" hint="Paused and dormant stop it being counted as drifting.">
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
      </Section>

      <WorklanesSection projectId={project.id} lanes={lanes} tasks={tasks} />

      <Section title="Details">
        <Panel>
          <dl className="space-y-2 text-[12px]">
            {[
              ['Workspace', project.workspaceName],
              ['Created', formatDate(project.createdAt.slice(0, 10))],
              ['Last activity', relativeFromIso(project.lastActivityAt)],
              ['Last opened', relativeFromIso(project.previousOpenedAt ?? project.lastOpenedAt)],
              ['Health', project.health.reasons.join(' · ')]
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-6">
                <dt className="shrink-0 text-base-content/45">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>

      <Section title="Archive and delete" tone="warn">
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
                Permanently removes its {tasks.length} items, worklanes, notes, meetings, decisions,
                journal and links. The people stay in the workspace. This cannot be undone.
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
      </Section>
    </div>
  )
}

/**
 * Worklanes are optional, so they get configured rather than cluttering the board.
 * The count of items in each is shown because deleting a lane is only safe once you
 * know what is sitting in it.
 */
function WorklanesSection({
  projectId,
  lanes,
  tasks
}: {
  projectId: string
  lanes: import('@shared/types').Lane[]
  tasks: import('@shared/types').TaskView[]
}): React.JSX.Element {
  const save = useApiMutation('lane:save')
  const remove = useApiMutation('lane:delete')
  const reorder = useApiMutation('lane:reorder')
  const [adding, setAdding] = useState('')

  const move = (index: number, delta: number): void => {
    const next = [...lanes]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    reorder.mutate({ ids: next.map((lane) => lane.id) })
  }

  const add = (): void => {
    if (!adding.trim()) return
    save.mutate({ projectId, name: adding.trim() })
    setAdding('')
  }

  return (
    <Section title="Worklanes" count={lanes.length}>
      <Panel padded={false}>
        {lanes.length === 0 && (
          <p className="px-4 py-3 text-[12px] leading-relaxed text-base-content/50">
            No worklanes. A project without them is a flat board — add lanes only when one list stops
            being readable, and they become swimlanes across the Kanban columns.
          </p>
        )}

        {lanes.map((lane, index) => {
          const count = tasks.filter((t) => t.laneId === lane.id && t.status === 'open').length
          return (
            <div key={lane.id} className="hairline group flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
              <Icon name="lane" size={13} className="text-base-content/30" />
              <input
                className="quiet-input min-w-0 flex-1 px-2 py-1 text-[13px]"
                defaultValue={lane.name}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== lane.name &&
                  save.mutate({ id: lane.id, name: e.target.value.trim() })
                }
              />
              <span className="shrink-0 text-[11px] tabular-nums text-base-content/35">
                {count} open
              </span>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                <button
                  className="btn btn-ghost btn-xs btn-circle"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move up"
                >
                  <Icon name="chevronUp" size={12} />
                </button>
                <button
                  className="btn btn-ghost btn-xs btn-circle"
                  disabled={index === lanes.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move down"
                >
                  <Icon name="chevronDown" size={12} />
                </button>
                <ConfirmButton
                  label="Delete"
                  onConfirm={() => remove.mutate({ id: lane.id })}
                />
              </div>
            </div>
          )
        })}

        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            className="input input-bordered input-sm flex-1"
            placeholder="New worklane…"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn btn-sm" disabled={!adding.trim()} onClick={add}>
            Add
          </button>
        </div>
      </Panel>
      {lanes.length > 0 && (
        <p className="mt-2 text-[11px] text-base-content/40">
          Deleting a worklane keeps its items — they move back to no lane.
        </p>
      )}
    </Section>
  )
}
