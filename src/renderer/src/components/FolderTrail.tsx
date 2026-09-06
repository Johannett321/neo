import { useState } from 'react'
import { branchIds, type Dragged, type Nested } from '@/lib/folders'
import { Icon } from './Icon'

/**
 * The way back out of a folder, and the way to take something with you.
 *
 * Drawn only when there is a way back: at the top level there are no crumbs, so
 * someone who never makes a folder never sees this line at all. That is the same rule
 * every part of filing is held to — with nothing filed, the page is exactly the page it
 * was before the feature existed.
 *
 * **Every crumb above the one you are in is a drop target**, and that is how something
 * gets back *out* again: the same gesture that put it in, aimed one level up, or at
 * the root to unfile it entirely. It is the only way out that does not need a dialog,
 * so it says so — while anything is in the air the trail draws each crumb it would
 * accept as a dashed outline, in the same language a folder uses when it offers
 * itself. A drop target nobody can see is a drop target nobody uses.
 */
export function FolderTrail<T extends Nested & { name: string }>({
  crumbs,
  folders,
  dragged,
  rootLabel,
  onOpen,
  onMoveHere
}: {
  /** The trail from the top down to the open folder, that folder last. */
  crumbs: T[]
  /** Every folder in the list — what a folder's move has to check itself against. */
  folders: T[]
  dragged: Dragged | null
  /** What the top level is called here: "All projects", "All notes". */
  rootLabel: string
  onOpen: (folderId: string | null) => void
  onMoveHere: (dragged: Dragged, folderId: string | null) => void
}): React.JSX.Element {
  const [over, setOver] = useState<string | null | undefined>(undefined)

  // Dropping something into the folder it is already open in is not a move, so the
  // last crumb takes nothing; everything above it does.
  const above = crumbs.slice(0, -1).map((c) => c.id)
  const accepts = (id: string | null): boolean => {
    if (!dragged) return false
    if (id !== null && !above.includes(id)) return false
    return dragged.kind === 'item' || id === null || !branchIds(folders, dragged.id).has(id)
  }

  const crumb = (id: string | null, label: string, last: boolean): React.JSX.Element => {
    const offering = accepts(id)
    return (
      <span key={id ?? 'root'} className="flex min-w-0 items-center gap-1">
        <button
          className={`truncate rounded px-1 py-0.5 transition ${
            over === id
              ? 'bg-primary/15 text-base-content'
              : offering
                ? // Something is in the air and this is a way out for it.
                  'border border-dashed border-primary/40 text-base-content/70'
                : last
                  ? 'text-base-content/70'
                  : 'hover:bg-base-content/5 hover:text-base-content'
          }`}
          onClick={() => onOpen(id)}
          onDragOver={(e) => {
            if (!offering) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setOver(id)
          }}
          onDragLeave={() => setOver(undefined)}
          onDrop={() => {
            setOver(undefined)
            if (dragged && offering) onMoveHere(dragged, id)
          }}
        >
          {label}
        </button>
        {!last && <Icon name="chevronRight" size={11} className="shrink-0 opacity-30" />}
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      {crumb(null, rootLabel, crumbs.length === 0)}
      {crumbs.map((folder, index) => crumb(folder.id, folder.name, index === crumbs.length - 1))}
    </span>
  )
}
