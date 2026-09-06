import { useState } from 'react'
import { plural } from '@/lib/format'
import { Icon } from './Icon'
import { Field, Modal } from './primitives'

/**
 * Choosing a folder: the one dialog that answers "where does this go?".
 *
 * It lives apart from the folders drawn on any one page because several right-click
 * menus ask the same question — a project's, a folder's, a note's, a meeting's — from
 * screens that have nothing else in common. One picker, so the answer looks the same
 * wherever it is asked, and so it looks the same whether what is being filed is a
 * project card or a page of writing.
 *
 * Everything here is written against the least a folder can be. The two folder trees in
 * the app count different things — projects in one, notes or meetings in the other —
 * and that difference lives at the call site, as a number, rather than here.
 */

/** The least a folder has to be to be pickable, and what the row shows beside it. */
export interface Pickable {
  id: string
  name: string
  /** How many levels down it sits, for the indent. Top-level folders are 0. */
  depth: number
  /** What is filed directly in it, if the caller wants that shown. */
  count?: number
}

/** The rows a folder picker shows: the top level, then every folder, indented. */
function FolderChoice({
  folders,
  value,
  rootLabel,
  exclude,
  onChange
}: {
  folders: Pickable[]
  value: string | null
  rootLabel: string
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
      {row(null, rootLabel, 0)}
      {folders
        .filter((f) => !exclude?.has(f.id))
        .map((f) => row(f.id, f.name, f.depth + 1, f.count))}
    </div>
  )
}

/**
 * Where does this go? One dialog, used by every menu that asks — the only difference
 * between them is that a folder cannot be moved into its own branch.
 */
export function MoveToFolderModal({
  open,
  onClose,
  folders,
  title,
  description,
  rootLabel = 'Not in a folder',
  current,
  exclude,
  onMove
}: {
  open: boolean
  onClose: () => void
  folders: Pickable[]
  title: string
  description: string
  /** What the top level is called here. The default suits everything so far. */
  rootLabel?: string
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
      <FolderChoice
        folders={folders}
        value={chosen}
        rootLabel={rootLabel}
        exclude={exclude}
        onChange={setChosen}
      />
    </Modal>
  )
}

/**
 * Creating one. The only thing a folder has is a name and somewhere to sit, so this is
 * the whole dialog — and the write itself belongs to the caller, since the two folder
 * trees are two channels and the dialog has no business knowing which it is filling.
 */
export function NewFolderModal({
  open,
  onClose,
  folders,
  parentId,
  description = 'Somewhere to file things. It holds nothing else, and nothing in the app reads it back.',
  rootLabel = 'Not in a folder',
  onCreate
}: {
  open: boolean
  onClose: () => void
  folders: Pickable[]
  parentId: string | null
  description?: string
  rootLabel?: string
  onCreate: (name: string, parentId: string | null) => Promise<unknown>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string | null>(parentId)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    await onCreate(name.trim(), parent)
    setName('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New folder"
      description={description}
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
            <FolderChoice
              folders={folders}
              value={parent}
              rootLabel={rootLabel}
              onChange={setParent}
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}
