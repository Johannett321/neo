import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Workspace } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace, useWorkspaces } from '@/lib/workspace'
import { plural } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { SettingsLayout } from '@/components/SettingsLayout'
import { WorkspaceModal, WORKSPACE_COLORS } from '@/components/WorkspaceModal'
import { ConfirmButton, Field, Panel } from '@/components/primitives'

/**
 * The workspace's own page. It sits apart from Settings because Settings is about the
 * app — where your data lives, who you are — while this is about one area of your
 * working life, and you switch between several of them.
 */
export function WorkspaceSettings(): React.JSX.Element {
  const workspace = useWorkspace()
  const [creating, setCreating] = useState(false)
  const { switchTo } = useWorkspaces()
  const navigate = useNavigate()

  return (
    <>
      <SettingsLayout
        title={workspace.name}
        subtitle="Everything about this workspace. Its projects and people stay inside it."
        exitTo="/"
        actions={
          <button className="btn btn-sm gap-1.5" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} />
            New workspace
          </button>
        }
        panes={[
          {
            id: 'identity',
            label: 'Identity',
            icon: 'sparkle',
            description: 'How you pick this workspace out of the switcher.',
            render: () => <IdentityPane workspace={workspace} />
          },
          {
            id: 'archive',
            label: 'Archive and delete',
            icon: 'archive',
            tone: 'warn',
            render: () => <DangerPane workspace={workspace} />
          }
        ]}
      />

      <WorkspaceModal
        open={creating}
        onClose={() => setCreating(false)}
        workspace={null}
        onSaved={(created) => {
          switchTo(created.id)
          navigate('/')
        }}
      />
    </>
  )
}

function IdentityPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const [name, setName] = useState(workspace.name)

  useEffect(() => setName(workspace.name), [workspace.id, workspace.name])

  return (
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
  )
}

function DangerPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { workspaces, switchTo } = useWorkspaces()
  const navigate = useNavigate()
  const setArchived = useApiMutation('workspace:setArchived')
  const remove = useApiMutation('workspace:delete')

  const projects = useApi('project:list', { workspaceId: workspace.id, status: 'all' })
  const people = useApi('person:list', { workspaceId: workspace.id })

  const leaveFor = (excludeId: string): void => {
    const next = workspaces.find((w) => w.id !== excludeId)
    if (next) switchTo(next.id)
    navigate('/')
  }

  return (
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
  )
}
