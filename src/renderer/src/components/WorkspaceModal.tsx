import { useEffect, useState } from 'react'
import type { Workspace } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { differs } from '@/lib/format'
import { ConfirmButton, Field, Modal } from './primitives'
import { IconPicker } from './IconPicker'

export const WORKSPACE_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#14b8a6', '#f43f5e'
]

export function WorkspaceModal({
  open,
  onClose,
  workspace,
  onSaved,
  onDeleted
}: {
  open: boolean
  onClose: () => void
  workspace: Workspace | null
  onSaved?: (workspace: Workspace) => void
  onDeleted?: () => void
}): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const remove = useApiMutation('workspace:delete')
  const setArchived = useApiMutation('workspace:setArchived')

  const [name, setName] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0] as string)
  const [iconPath, setIconPath] = useState('')
  const [iconPreview, setIconPreview] = useState<string | null>(null)

  const original = {
    name: workspace?.name ?? '',
    color: workspace?.color ?? (WORKSPACE_COLORS[0] as string),
    iconPath: workspace?.iconPath ?? ''
  }

  useEffect(() => {
    if (!open) return
    setName(workspace?.name ?? '')
    setColor(workspace?.color ?? (WORKSPACE_COLORS[0] as string))
    setIconPath(workspace?.iconPath ?? '')
    setIconPreview(workspace?.icon ?? null)
  }, [open, workspace])

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    const saved = await save.mutateAsync({ id: workspace?.id, name: name.trim(), color, iconPath })
    onSaved?.(saved)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={workspace ? 'Workspace settings' : 'New workspace'}
      description={
        workspace
          ? undefined
          : 'A separate area of your working life. Nothing crosses between workspaces.'
      }
      onSubmit={() => void submit()}
      isDirty={differs({ name, color, iconPath }, original)}
      footer={
        <>
          {workspace && onDeleted && (
            <div className="mr-auto flex items-center gap-1">
              <button
                className="btn btn-ghost btn-sm text-base-content/55"
                onClick={async () => {
                  await setArchived.mutateAsync({
                    id: workspace.id,
                    archived: !workspace.archivedAt
                  })
                  if (!workspace.archivedAt) onDeleted()
                  onClose()
                }}
              >
                {workspace.archivedAt ? 'Restore' : 'Archive'}
              </button>
              <ConfirmButton
                label="Delete"
                className="btn btn-ghost btn-sm text-base-content/50 hover:text-error"
                onConfirm={async () => {
                  await remove.mutateAsync({ id: workspace.id })
                  onDeleted()
                  onClose()
                }}
              />
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => void submit()}>
            {workspace ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {workspace?.archivedAt && (
          <p className="hairline rounded-field border px-3 py-2 text-[12px] text-base-content/55">
            This workspace is archived — hidden from the switcher until you restore it. Nothing inside it
            has been touched.
          </p>
        )}
        {workspace && !workspace.archivedAt && (
          <p className="text-[11px] leading-snug text-base-content/40">
            Archiving hides a workspace and everything in it, reversibly. Deleting removes its projects,
            people, notes and decisions permanently.
          </p>
        )}
        <IconPicker
          name={name}
          color={color}
          icon={iconPreview}
          hint="PNG, JPG, WebP, GIF or SVG, up to 2 MB. Without one, the colour and initial are used."
          onChange={({ iconPath: next, icon }) => {
            setIconPath(next)
            setIconPreview(icon)
          }}
        />

        <Field label="Name">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Day job, My company, Consultancy…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label="Colour" hint="Used for the mark above and to tint this workspace's sidebar.">
          <div className="flex flex-wrap gap-1.5 pt-1">
            {WORKSPACE_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`size-7 rounded-full transition ${
                  color === swatch ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100' : ''
                }`}
                style={{ backgroundColor: swatch }}
                onClick={() => setColor(swatch)}
                aria-label={swatch}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  )
}
