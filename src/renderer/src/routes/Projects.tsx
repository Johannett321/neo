import { useState } from 'react'
import { useApi, useApiMutation } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { differs, plural } from '@/lib/format'
import { Icon } from '@/components/Icon'
import { EmptyState, Field, Modal, PageHeader } from '@/components/primitives'
import { IconPicker } from '@/components/IconPicker'
import { ProjectCard } from '@/components/ProjectCard'



export function ProjectsPage(): React.JSX.Element {
  const workspace = useWorkspace()
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)

  // "Active" simply means not archived — the finer statuses are shown on the cards
  // rather than being another thing to filter by.
  const projects = useApi('project:list', {
    workspaceId: workspace.id,
    status: 'all',
    archived: showArchived
  })
  const archived = useApi('project:list', { workspaceId: workspace.id, status: 'all', archived: true })
  const list = projects.data ?? []
  const archivedCount = archived.data?.length ?? 0

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={
          projects.data ? (
            <span className="flex items-center gap-3">
              <span>
                {plural(list.length, showArchived ? 'archived project' : 'project')} in {workspace.name}
              </span>
              {(archivedCount > 0 || showArchived) && (
                <button
                  className="text-base-content/45 underline decoration-base-content/20 underline-offset-2 transition hover:text-base-content hover:decoration-current"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? 'Back to active' : `Archived (${archivedCount})`}
                </button>
              )}
            </span>
          ) : (
            ' '
          )
        }
        actions={
          <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New project
          </button>
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={showArchived ? 'archive' : 'projects'}
          title={showArchived ? 'Nothing archived.' : 'No projects here yet.'}
          hint={
            showArchived
              ? 'Archiving a project puts it out of the way without deleting anything.'
              : "A project is anything you would otherwise have to hold in your head: a team's workstream, a client engagement, a side of the business."
          }
          action={
            !showArchived && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                Create one
              </button>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      <NewProjectModal open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const workspace = useWorkspace()
  const save = useApiMutation('project:save')
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [iconPath, setIconPath] = useState('')
  const [iconPreview, setIconPreview] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    await save.mutateAsync({
      name: name.trim(),
      summary,
      iconPath,
      workspaceId: workspace.id,
      status: 'active'
    })
    setName('')
    setSummary('')
    setIconPath('')
    setIconPreview(null)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description={`It will live in ${workspace.name}.`}
      onSubmit={() => void submit()}
      isDirty={differs({ name, summary, iconPath }, { name: '', summary: '', iconPath: '' })}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => void submit()}>
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <IconPicker
          name={name}
          color={workspace.color}
          icon={iconPreview}
          size={44}
          hint="Optional. Without one the project shows its initial."
          onChange={({ iconPath: next, icon }) => {
            setIconPath(next)
            setIconPreview(icon)
          }}
        />
        <Field label="Name">
          <input
            autoFocus
            className="input input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="One line about it">
          <input
            className="input input-bordered w-full"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
