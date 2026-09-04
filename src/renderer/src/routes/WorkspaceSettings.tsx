import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace, useWorkspaces } from '@/lib/workspace'
import { formatDate, plural } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { Mark } from '@/components/Mark'
import { WorkspaceModal, WORKSPACE_COLORS } from '@/components/WorkspaceModal'
import { ConfirmButton, Field, PageHeader, Panel, Section } from '@/components/primitives'

/**
 * The workspace's own page. It sits apart from Settings because Settings is about the
 * app — where your data lives, who you are — while this is about one area of your
 * working life, and you switch between several of them.
 */
export function WorkspaceSettings(): React.JSX.Element {
  const workspace = useWorkspace()
  const { workspaces, switchTo } = useWorkspaces()
  const navigate = useNavigate()

  const save = useApiMutation('workspace:save')
  const setArchived = useApiMutation('workspace:setArchived')
  const remove = useApiMutation('workspace:delete')

  const projects = useApi('project:list', { workspaceId: workspace.id, status: 'all' })
  const people = useApi('person:list', { workspaceId: workspace.id })

  const [name, setName] = useState(workspace.name)
  const [creating, setCreating] = useState(false)

  useEffect(() => setName(workspace.name), [workspace.id, workspace.name])

  const leaveFor = (excludeId: string): void => {
    const next = workspaces.find((w) => w.id !== excludeId)
    if (next) switchTo(next.id)
    navigate('/')
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={workspace.name}
        subtitle="Everything about this workspace. Its projects and people stay inside it."
        actions={
          <button className="btn btn-sm gap-1.5" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} />
            New workspace
          </button>
        }
      />

      <Section title="Identity">
        <Panel>
          <IconPicker
            name={workspace.name}
            color={workspace.color}
            icon={workspace.icon}
            hint="Shown in the switcher at the bottom of the sidebar. Without one, the colour and initial are used."
            onChange={({ iconPath }) => save.mutate({ id: workspace.id, iconPath })}
          />

          <div className="mt-5 space-y-4">
            <Field label="Name">
              <input
                className="input input-bordered w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() =>
                  name.trim() && name !== workspace.name && save.mutate({ id: workspace.id, name: name.trim() })
                }
              />
            </Field>

            <Field label="Colour" hint="Tints the sidebar, so it is always obvious which area you are in.">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {WORKSPACE_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className={`size-7 rounded-full transition ${
                      workspace.color === swatch
                        ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100'
                        : ''
                    }`}
                    style={{ backgroundColor: swatch }}
                    onClick={() => save.mutate({ id: workspace.id, color: swatch })}
                    aria-label={swatch}
                  />
                ))}
              </div>
            </Field>
          </div>
        </Panel>
      </Section>

      <Section title="What is in it">
        <Panel>
          <dl className="space-y-2 text-[12px]">
            {[
              ['Projects', plural(projects.data?.length ?? 0, 'project')],
              ['People', plural(people.data?.length ?? 0, 'person', 'people')],
              ['Created', formatDate(workspace.createdAt.slice(0, 10))]
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-6">
                <dt className="text-base-content/45">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>

      <Section title="Other workspaces">
        <Panel padded={false}>
          {workspaces
            .filter((w) => w.id !== workspace.id)
            .map((other) => (
              <button
                key={other.id}
                className="row-hover hairline flex w-full items-center gap-2.5 border-b px-4 py-2.5 text-left last:border-b-0"
                onClick={() => {
                  switchTo(other.id)
                  navigate('/')
                }}
              >
                <Mark name={other.name} color={other.color} icon={other.icon} size={22} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{other.name}</span>
                <span className="text-[11px] text-base-content/40">Switch</span>
              </button>
            ))}
          {workspaces.length === 1 && (
            <p className="px-4 py-3 text-[12px] text-base-content/45">
              This is your only workspace. Add another when a part of your work needs to stay separate.
            </p>
          )}
        </Panel>
      </Section>

      <Section title="Archive and delete" tone="warn">
        <Panel>
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <div className="text-[13px] font-medium">
                {workspace.archivedAt ? 'Restore this workspace' : 'Archive this workspace'}
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
                {workspace.archivedAt
                  ? 'Bring it back into the switcher.'
                  : 'Hides it and everything in it from the switcher, reversibly. Nothing inside is touched, and it can be restored from the switcher at any time.'}
              </p>
            </div>
            <button
              className="btn btn-sm gap-1.5"
              disabled={workspaces.length === 1 && !workspace.archivedAt}
              title={
                workspaces.length === 1 && !workspace.archivedAt
                  ? 'You would have no workspace left open'
                  : undefined
              }
              onClick={async () => {
                await setArchived.mutateAsync({ id: workspace.id, archived: !workspace.archivedAt })
                if (!workspace.archivedAt) leaveFor(workspace.id)
              }}
            >
              <Icon name="archive" size={13} />
              {workspace.archivedAt ? 'Restore' : 'Archive'}
            </button>
          </div>

          <div className="hairline mt-4 flex items-start gap-4 border-t pt-4">
            <div className="flex-1">
              <div className="text-[13px] font-medium">Delete this workspace</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
                Permanently removes its {plural(projects.data?.length ?? 0, 'project')} and{' '}
                {plural(people.data?.length ?? 0, 'person', 'people')}, with every note, meeting, decision
                and log entry inside them. This cannot be undone.
              </p>
            </div>
            <ConfirmButton
              label="Delete"
              title={`Delete ${workspace.name}?`}
              body={`Its ${plural(projects.data?.length ?? 0, 'project')} and everything inside them go with it. Archiving hides it instead, and keeps it all.`}
              className="btn btn-sm text-base-content/60 hover:text-error"
              onConfirm={async () => {
                await remove.mutateAsync({ id: workspace.id })
                leaveFor(workspace.id)
              }}
            />
          </div>
        </Panel>
      </Section>

      <WorkspaceModal
        open={creating}
        onClose={() => setCreating(false)}
        workspace={null}
        onSaved={(created) => {
          switchTo(created.id)
          navigate('/')
        }}
      />
    </div>
  )
}
