import { useEffect, useState } from 'react'
import type { ProjectFolderView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { branchIds } from '@/lib/folders'
import { plural } from '@/lib/format'
import { useToast } from '@/lib/toast'
import { useGoIn, useWorkspaces } from '@/lib/workspace'
import { Icon } from './Icon'
import { Mark } from './Mark'
import { Modal } from './primitives'

/**
 * Taking a whole project to another workspace — the one started in the wrong area of
 * your life, or handed over to a shared one.
 *
 * Two things happen that are worth saying before they do. People belong to a workspace,
 * so everybody the project names is matched to the same person in the other one or
 * copied there. And folders belong to a workspace too, so it arrives unfiled. Then you
 * go with it: the project opens in the workspace it has landed in.
 */
export function MoveProjectModal({
  open,
  onClose,
  project
}: {
  open: boolean
  onClose: () => void
  project: { id: string; name: string; workspaceId: string }
}): React.JSX.Element {
  const goIn = useGoIn()
  const toast = useToast()
  const move = useApiMutation('project:move')

  return (
    <MoveToWorkspaceModal
      open={open}
      onClose={onClose}
      name={project.name}
      from={project.workspaceId}
      submitLabel="Move project"
      pending={move.isPending}
      error={move.error}
      explain={(there) => (
        <>
          Everything in it goes along. The people on it are matched to the same people in{' '}
          {there}, or copied there; they also stay where they are. It leaves its folder behind
          and arrives unfiled.
        </>
      )}
      onMove={async (target) => {
        await move.mutateAsync({ id: project.id, workspaceId: target.id })
        onClose()
        toast({ title: `Moved to ${target.name}`, detail: project.name, icon: 'arrowRight' })
        goIn(target.id, `/projects/${project.id}`)
      }}
    />
  )
}

/**
 * Taking a whole folder to another workspace: the same move as a project's, made for
 * every project filed anywhere inside it at once. The folder keeps its insides — its
 * subfolders, the bands drawn in them, which card is where — and lands at the top level
 * of the other workspace, which is where you are taken to find it open.
 */
export function MoveFolderModal({
  open,
  onClose,
  folder,
  folders
}: {
  open: boolean
  onClose: () => void
  folder: { id: string; name: string; workspaceId: string }
  /** Every folder in its workspace, to count what goes with it. */
  folders: ProjectFolderView[]
}): React.JSX.Element {
  const goIn = useGoIn()
  const toast = useToast()
  const move = useApiMutation('folder:move')
  const branch = branchIds(folders, folder.id)
  const inside = folders.filter((f) => branch.has(f.id))
  const subfolders = inside.length - 1
  const projects = inside.reduce((n, f) => n + f.projectCount, 0)
  const contents = [
    subfolders === 1 ? 'its subfolder' : subfolders > 1 ? `its ${subfolders} subfolders` : '',
    projects === 1 ? 'the project in it' : projects === 2 ? 'both projects in it' : projects > 2 ? `all ${plural(projects, 'project')} in it` : ''
  ].filter(Boolean)

  return (
    <MoveToWorkspaceModal
      open={open}
      onClose={onClose}
      name={folder.name}
      from={folder.workspaceId}
      submitLabel="Move folder"
      pending={move.isPending}
      error={move.error}
      explain={(there) => (
        <>
          {contents.length > 0
            ? `It goes with ${contents.join(' and ')}, filed as they are now`
            : 'It goes as it is'}
          , archived projects in it too. The people on them are matched to the same people in{' '}
          {there}, or copied there; they also stay where they are. It arrives at the top level.
        </>
      )}
      onMove={async (target) => {
        await move.mutateAsync({ id: folder.id, workspaceId: target.id })
        onClose()
        toast({ title: `Moved to ${target.name}`, detail: folder.name, icon: 'arrowRight' })
        goIn(target.id, `/projects?in=${folder.id}`)
      }}
    />
  )
}

/** Pick another workspace, read what will happen, move. */
function MoveToWorkspaceModal({
  open,
  onClose,
  name,
  from,
  submitLabel,
  pending,
  error,
  explain,
  onMove
}: {
  open: boolean
  onClose: () => void
  name: string
  /** The workspace it is in, which is not offered. */
  from: string
  submitLabel: string
  pending: boolean
  error: Error | null
  /** What happens, given the chosen workspace's name (or a stand-in for it). */
  explain: (there: string) => React.ReactNode
  onMove: (target: { id: string; name: string }) => Promise<void>
}): React.JSX.Element {
  const { workspaces } = useWorkspaces()
  const options = workspaces.filter((w) => w.id !== from)
  const [chosen, setChosen] = useState<string | null>(null)

  useEffect(() => {
    if (open) setChosen(null)
  }, [open])

  const target = options.find((w) => w.id === chosen)

  const submit = async (): Promise<void> => {
    if (!target || pending) return
    await onMove(target)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Move to another workspace"
      description={name}
      width="max-w-md"
      onSubmit={() => void submit()}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!target || pending}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="scroll-area hairline max-h-64 overflow-y-auto rounded-box border p-1">
          {options.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-base-content/40">
              There is no other workspace to move it to.
            </div>
          ) : (
            options.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-[13px] transition ${
                  chosen === w.id ? 'bg-primary/10 font-medium' : 'hover:bg-base-content/5'
                }`}
                onClick={() => setChosen(w.id)}
              >
                <Mark name={w.name} color={w.color} icon={w.icon} size={18} rounded="rounded-[5px]" />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {chosen === w.id && <Icon name="check" size={13} className="text-primary" />}
              </button>
            ))
          )}
        </div>

        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-base-content/55">
          <Icon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>{explain(target ? target.name : 'the other workspace')}</span>
        </p>
        {error && <p className="text-[12px] text-error">{error.message}</p>}
      </div>
    </Modal>
  )
}
