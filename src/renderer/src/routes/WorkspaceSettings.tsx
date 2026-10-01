import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_RECAP_PROMPT } from '@shared/recording'
import type { Workspace } from '@shared/types'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace, useWorkspaces } from '@/lib/workspace'
import { plural } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { NotificationPane } from '@/components/NotificationSettings'
import { MembersPane } from '@/components/Sharing'
import { SettingsLayout } from '@/components/SettingsLayout'
import { TodayPane } from '@/components/today/TodaySettings'
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
            id: 'members',
            label: 'Members',
            icon: 'people',
            description:
              workspace.role === 'owner'
                ? 'Invite people to work in this workspace with you.'
                : 'Who else works in this workspace.',
            render: () => <MembersPane workspace={workspace} />
          },
          {
            id: 'today',
            label: 'Today',
            icon: 'today',
            description: 'The banner, the weather and what the morning screen shows.',
            render: () => <TodayPane workspace={workspace} />
          },
          {
            id: 'notifications',
            label: 'Notifications',
            icon: 'bell',
            description: 'What this working life is worth being interrupted about.',
            render: () => <NotificationPane workspace={workspace} />
          },
          {
            id: 'recording',
            label: 'Recording',
            icon: 'mic',
            description: 'The language meetings are in, and what the recap should look for.',
            render: () => <RecordingPane workspace={workspace} />
          },
          workspace.role === 'owner'
            ? {
                id: 'archive',
                label: 'Archive and delete',
                icon: 'archive',
                tone: 'warn',
                render: () => <DangerPane workspace={workspace} />
              }
            : {
                id: 'archive',
                label: 'Leave',
                icon: 'arrowLeft',
                tone: 'warn',
                render: () => <LeavePane workspace={workspace} />
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
        <Field
          label="Name"
          hint={
            workspace.role === 'owner'
              ? undefined
              : `Only ${workspace.members.find((m) => m.role === 'owner')?.name ?? 'the owner'} can rename it.`
          }
        >
          <input
            className="input input-bordered w-full"
            disabled={workspace.role !== 'owner'}
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

/**
 * What happens to a meeting after it has been recorded.
 *
 * Which service transcribes and which model writes the recap are Neo Cloud's to decide —
 * every workspace runs on the same operator key, so there is no engine or key to pick.
 * What is left is what only this working life knows: the language its meetings are in,
 * and what its recaps should pay attention to.
 */
function RecordingPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const set = (patch: Partial<Workspace>): void => {
    save.mutate({ id: workspace.id, ...patch })
  }

  return (
    <div className="space-y-4">
      <Panel>
        <Field
          label="Language"
          hint="A two-letter code such as no or en. Leave it empty and transcription works it out — naming it is more accurate when you already know."
        >
          <input
            className="input input-bordered input-sm w-28"
            placeholder="auto"
            maxLength={5}
            defaultValue={workspace.transcribeLanguage}
            key={workspace.id}
            onBlur={(e) => set({ transcribeLanguage: e.target.value.trim().toLowerCase() })}
          />
        </Field>
        <p className="mt-3 text-[11.5px] leading-relaxed text-base-content/45">
          Recordings are transcribed in Neo Cloud one five-minute part at a time, so an interrupted
          transcription resumes at the part it reached.
        </p>
      </Panel>

      <Panel>
        <Field
          label="What to ask for"
          hint="Yours to change. The shape of the answer — decisions, commitments, key insights — is fixed, because the screen reads them as separate things and can put a commitment straight onto the to-do list."
        >
          <textarea
            className="textarea textarea-bordered h-72 w-full text-[12.5px] leading-relaxed"
            defaultValue={workspace.recapPrompt || DEFAULT_RECAP_PROMPT}
            key={workspace.id + String(workspace.recapPrompt === '')}
            onBlur={(e) => {
              const value = e.target.value.trim()
              // Storing an empty string means "the default", so the prompt keeps up
              // with the app rather than freezing a copy of an old one.
              set({ recapPrompt: value === DEFAULT_RECAP_PROMPT.trim() ? '' : value })
            }}
          />
        </Field>
        {workspace.recapPrompt !== '' && (
          <button
            className="btn btn-ghost btn-xs mt-2"
            onClick={() => set({ recapPrompt: '' })}
          >
            Back to the default
          </button>
        )}
      </Panel>
    </div>
  )
}

/** A member's way out. The owner's is deleting, in the pane this replaces. */
function LeavePane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { workspaces, switchTo } = useWorkspaces()
  const navigate = useNavigate()
  const remove = useApiMutation('workspace:removeMember')
  const me = workspace.members.find((m) => m.isMe)
  const owner = workspace.members.find((m) => m.role === 'owner')?.name ?? 'the owner'

  return (
    <Panel>
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="text-[13px] font-medium">Leave {workspace.name}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            It disappears from your switcher and you lose access to everything in it. The work you did stays
            for everybody else; your conversations with the assistant about it go. {owner} can invite you back.
          </p>
        </div>
        {me && (
          <ConfirmButton
            label="Leave"
            title={`Leave ${workspace.name}?`}
            body={`You will need a new invitation from ${owner} to come back.`}
            className="btn btn-sm text-base-content/60 hover:text-error"
            onConfirm={async () => {
              await remove.mutateAsync({ workspaceId: workspace.id, accountId: me.accountId })
              const next = workspaces.find((w) => w.id !== workspace.id)
              if (next) switchTo(next.id)
              navigate('/')
            }}
          />
        )}
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
          body={`Its ${plural(projects.data?.length ?? 0, 'project')} and everything inside them go with it${
            workspace.members.length > 1
              ? `, for ${plural(workspace.members.length - 1, 'other person', 'other people')} in it too`
              : ''
          }. Archiving hides it instead, and keeps it all.`}
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
