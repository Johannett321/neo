import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_MODEL, MODELS } from '@shared/ai'
import type { Workspace } from '@shared/types'
import { call, useApi, useApiMutation } from '@/lib/api'
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
            id: 'assistant',
            label: 'Assistant',
            icon: 'sparkle',
            description: 'The key it runs on, and which model it uses.',
            render: () => <AssistantPane workspace={workspace} />
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

/**
 * The assistant's key lives on the workspace rather than on the app, because a
 * workspace *is* a separate working life: the key a consultancy bills through should
 * not be the one a day job's questions go out on, and the boundary the rest of the
 * app enforces on data should hold for what leaves the machine too.
 *
 * The key is write-only across the bridge. It is stored beside everything else in
 * `~/Documents/Neo` and never sent back to the renderer — all this screen is ever
 * told is whether there is one, which is all it needs to know.
 */
function AssistantPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const client = useQueryClient()
  const save = useApiMutation('workspace:save')
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setKey('')
    setEditing(false)
    setError('')
  }, [workspace.id])

  const setApiKey = async (value: string): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await call('chat:setKey', { workspaceId: workspace.id, apiKey: value })
      await client.invalidateQueries()
      setKey('')
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel>
      <Field
        label="OpenAI API key"
        hint="Kept in this workspace's own data and never sent anywhere but OpenAI. Get one at platform.openai.com."
      >
        {workspace.aiKeySet && !editing ? (
          <div className="hairline flex items-center gap-2 rounded-field border bg-base-200/50 px-3 py-2">
            <Icon name="check" size={14} className="text-success" />
            <span className="flex-1 text-[13px] text-base-content/70">A key is saved for this workspace.</span>
            <button className="btn btn-ghost btn-xs" onClick={() => setEditing(true)}>
              Replace
            </button>
            <ConfirmButton
              label="Remove"
              title="Remove this key?"
              body="The assistant stops working in this workspace until you add another. Nothing else is touched."
              confirmLabel="Remove"
              className="btn btn-ghost btn-xs text-base-content/50 hover:text-error"
              onConfirm={() => void setApiKey('')}
            />
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              className="input input-bordered w-full font-mono text-[12.5px]"
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && key.trim()) void setApiKey(key.trim())
              }}
            />
            <button
              className="btn btn-primary btn-sm shrink-0 self-center"
              disabled={!key.trim() || saving}
              onClick={() => void setApiKey(key.trim())}
            >
              Save
            </button>
            {workspace.aiKeySet && (
              <button
                className="btn btn-ghost btn-sm shrink-0 self-center"
                onClick={() => {
                  setKey('')
                  setEditing(false)
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </Field>

      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}

      <div className="hairline mt-5 border-t pt-5">
        <Field label="Model" hint="Every question and every answer is billed to the key above.">
          <div className="space-y-1">
            {MODELS.map((model) => {
              const isActive = (workspace.aiModel || DEFAULT_MODEL) === model.id
              return (
                <button
                  key={model.id}
                  className={`hairline flex w-full items-center gap-3 rounded-field border px-3 py-2 text-left transition ${
                    isActive ? 'border-primary/40 bg-primary/5' : 'hover:bg-base-200/60'
                  }`}
                  onClick={() => save.mutate({ id: workspace.id, aiModel: model.id })}
                >
                  <span
                    className={`size-3.5 shrink-0 rounded-full border-[1.5px] ${
                      isActive ? 'border-primary bg-primary' : 'border-base-content/25'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{model.label}</span>
                    <span className="block text-[11.5px] text-base-content/50">{model.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </Field>
      </div>

      <p className="mt-5 text-[11.5px] leading-relaxed text-base-content/45">
        The assistant can only see this workspace, and it asks before it changes anything — every
        write is shown to you in plain words first, and nothing happens until you say yes.
      </p>
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
