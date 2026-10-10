import { useEffect, useState } from 'react'
import { useApiMutation } from '@/lib/api'
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
  const { workspaces } = useWorkspaces()
  const goIn = useGoIn()
  const toast = useToast()
  const move = useApiMutation('project:move')
  const options = workspaces.filter((w) => w.id !== project.workspaceId)
  const [chosen, setChosen] = useState<string | null>(null)

  useEffect(() => {
    if (open) setChosen(null)
  }, [open])

  const target = options.find((w) => w.id === chosen)

  const submit = async (): Promise<void> => {
    if (!target || move.isPending) return
    await move.mutateAsync({ id: project.id, workspaceId: target.id })
    onClose()
    toast({ title: `Moved to ${target.name}`, detail: project.name, icon: 'arrowRight' })
    goIn(target.id, `/projects/${project.id}`)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Move to another workspace"
      description={project.name}
      width="max-w-md"
      onSubmit={() => void submit()}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!target || move.isPending}
            onClick={() => void submit()}
          >
            Move project
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
          <span>
            Everything in it goes along. The people on it are matched to the same people in{' '}
            {target ? target.name : 'the other workspace'}, or copied there; they also stay where
            they are. It leaves its folder behind and arrives unfiled.
          </span>
        </p>
        {move.error && <p className="text-[12px] text-error">{move.error.message}</p>}
      </div>
    </Modal>
  )
}
