import { useState } from 'react'
import type { ProjectFolderView } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { plural } from '@/lib/format'
import { Icon } from './Icon'
import { Field, Modal } from './primitives'

/**
 * Choosing a folder: the one dialog that answers "where does this go?".
 *
 * It lives apart from the folder headings on the projects page because a project's
 * own right-click menu asks the same question, from a card that may be on any screen.
 * One picker, so the answer looks the same wherever it is asked.
 */

/** The rows a folder picker shows: the top level, then every folder, indented. */
function FolderChoice({
  folders,
  value,
  exclude,
  onChange
}: {
  folders: ProjectFolderView[]
  value: string | null
  exclude?: Set<string>
  onChange: (id: string | null) => void
}): React.JSX.Element {
  const row = (id: string | null, label: string, depth: number, count?: number): React.JSX.Element => (
    <button
      key={id ?? 'root'}
      type="button"
      className={`flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-[13px] transition ${
        value === id ? 'bg-primary/10 font-medium' : 'hover:bg-base-content/5'
      }`}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => onChange(id)}
    >
      <Icon name={id ? 'folder' : 'projects'} size={14} className="shrink-0 opacity-45" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[11px] tabular-nums text-base-content/35">{count}</span>
      )}
      {value === id && <Icon name="check" size={13} className="text-primary" />}
    </button>
  )

  return (
    <div className="scroll-area hairline max-h-64 rounded-box border p-1">
      {row(null, 'Not in a folder', 0)}
      {folders
        .filter((f) => !exclude?.has(f.id))
        .map((f) => row(f.id, f.name, f.depth + 1, f.projectCount))}
    </div>
  )
}

/**
 * Where does this go? One dialog, used by a project's menu and a folder's alike —
 * the only difference is that a folder cannot be moved into its own branch.
 */
export function MoveToFolderModal({
  open,
  onClose,
  folders,
  title,
  description,
  current,
  exclude,
  onMove
}: {
  open: boolean
  onClose: () => void
  folders: ProjectFolderView[]
  title: string
  description: string
  current: string | null
  exclude?: Set<string>
  onMove: (folderId: string | null) => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<string | null>(current)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="max-w-md"
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onMove(chosen)
              onClose()
            }}
          >
            Move
          </button>
        </>
      }
    >
      <FolderChoice folders={folders} value={chosen} exclude={exclude} onChange={setChosen} />
    </Modal>
  )
}

/** Creating one. The only thing a folder has is a name and somewhere to sit. */
export function NewFolderModal({
  open,
  onClose,
  workspaceId,
  folders,
  parentId
}: {
  open: boolean
  onClose: () => void
  workspaceId: string
  folders: ProjectFolderView[]
  parentId: string | null
}): React.JSX.Element {
  const save = useApiMutation('folder:save')
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string | null>(parentId)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    await save.mutateAsync({ workspaceId, name: name.trim(), parentId: parent })
    setName('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New folder"
      description="Somewhere to file projects. It holds nothing else, and nothing in the app reads it back."
      width="max-w-md"
      onSubmit={() => void submit()}
      isDirty={name.trim().length > 0}
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
        <Field label="Name">
          <input
            autoFocus
            className="input input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {folders.length > 0 && (
          <Field label="Inside" hint={`${plural(folders.length, 'folder')} so far.`}>
            <FolderChoice folders={folders} value={parent} onChange={setParent} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
