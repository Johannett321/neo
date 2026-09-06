import { useState } from 'react'
import type { ProjectCollapsibleView, ProjectSummary } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import type { MenuItem } from '@/lib/contextMenu'
import { useContextMenu } from '@/lib/contextMenu'
import { plural } from '@/lib/format'
import { Icon } from './Icon'
import type { Dragged } from '@/lib/folders'
import { ProjectGrid } from './ProjectGrid'

/**
 * Collapsibles on the projects page: grouping that does not take you anywhere.
 *
 * A folder answers "put this away"; a collapsible answers "keep these together, and let
 * me fold them out of sight when I am not looking at them". The difference is worth two
 * concepts rather than one with a switch: clicking a folder replaces the page, and
 * clicking a collapsible does not — the cards stay where they are, on the page you are
 * already on, under the loose ones and under a name you gave them.
 *
 * They are drawn *below* every project that is in none of them, always, because that is
 * what makes the page still legible to someone who has one band and forty loose cards:
 * the ungrouped work is the page, and the bands are what has been tidied off the end of
 * it. And with no collapsibles at all, none of this is drawn — the same bargain the
 * folders make.
 */

/**
 * One band: a name, a rule across the page, and the cards in it.
 *
 * The whole band is a drop target rather than only its header, so a card can be aimed
 * at the group instead of at a two-line strip of it — but only for a card that is not
 * already in it, which is what leaves the grid inside free to go on reordering itself.
 */
export function CollapsibleSection({
  collapsible,
  projects,
  carried,
  naming,
  onDragged,
  onAdopt,
  onNewProject,
  onNamed
}: {
  collapsible: ProjectCollapsibleView
  /** The projects in this band, in the order the page draws them. */
  projects: ProjectSummary[]
  /** The project in the air anywhere on the page, or null. */
  carried: ProjectSummary | null
  /** Just made, so it opens with its name selected and waiting to be typed over. */
  naming: boolean
  onDragged: (dragged: Dragged | null) => void
  onAdopt: (projectId: string) => void
  onNewProject: () => void
  onNamed: () => void
}): React.JSX.Element {
  const save = useApiMutation('collapsible:save')
  const remove = useApiMutation('collapsible:delete')
  const openMenu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [over, setOver] = useState(false)

  const editing = renaming || naming
  const shut = collapsible.isCollapsed
  // A card already in this band is being reordered inside it, not moved into it.
  const accepts = carried !== null && carried.collapsibleId !== collapsible.id

  const rename = (value: string): void => {
    setRenaming(false)
    onNamed()
    const name = value.trim()
    if (name && name !== collapsible.name) save.mutate({ id: collapsible.id, name })
  }

  const items: MenuItem[] = [
    { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) },
    {
      label: shut ? 'Expand' : 'Collapse',
      icon: shut ? 'chevronDown' : 'chevronUp',
      onSelect: () => save.mutate({ id: collapsible.id, isCollapsed: !shut })
    },
    { label: 'New project in here', icon: 'plus', onSelect: onNewProject },
    'separator',
    {
      label: 'Delete collapsible',
      icon: 'trash',
      danger: true,
      onSelect: () => remove.mutate({ id: collapsible.id }),
      // Nothing is lost when it is empty, so nothing is asked.
      confirm:
        projects.length > 0
          ? {
              title: `Delete ${collapsible.name}?`,
              body: 'Only the collapsible goes. The projects in it come back up to the cards above.',
              confirmLabel: 'Delete collapsible'
            }
          : undefined
    }
  ]

  return (
    <section
      className={`mt-6 rounded-box transition ${
        over ? 'bg-primary/[0.07] ring-1 ring-primary/40' : ''
      }`}
      onDragOver={(e) => {
        if (!accepts) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        if (!accepts || !carried) return
        e.preventDefault()
        setOver(false)
        onAdopt(carried.id)
      }}
      onContextMenu={(e) => openMenu(e, items)}
    >
      <div className="flex items-center gap-2 px-1 pb-2 pt-1">
        {editing ? (
          <input
            autoFocus
            defaultValue={collapsible.name}
            className="input input-bordered input-xs w-56 text-[13px]"
            onFocus={(e) => e.currentTarget.select()}
            onContextMenu={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') rename((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') {
                setRenaming(false)
                onNamed()
              }
            }}
          />
        ) : (
          <button
            className="group flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition hover:bg-base-content/5"
            onClick={() => save.mutate({ id: collapsible.id, isCollapsed: !shut })}
            onDoubleClick={() => setRenaming(true)}
          >
            <Icon
              name="chevronDown"
              size={13}
              className={`shrink-0 text-base-content/40 transition-transform ${shut ? '-rotate-90' : ''}`}
            />
            <span className="truncate text-[13px] font-medium tracking-[-0.01em]">
              {collapsible.name}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-base-content/35">
              {projects.length}
            </span>
          </button>
        )}
        {/* The rule is what makes it a band rather than a heading floating above a grid. */}
        <span className="hairline min-w-0 flex-1 border-t" />
      </div>

      {shut ? (
        // Folded, it still says what is inside it — a band you cannot see into is a
        // place to lose things.
        <p className="px-2 pb-1 text-[11px] text-base-content/35">
          {projects.length > 0 ? `${plural(projects.length, 'project')} folded away` : 'Empty'}
        </p>
      ) : projects.length === 0 ? (
        <div className="hairline rounded-box border border-dashed px-3 py-5 text-center text-[12px] text-base-content/35">
          Drag a project card in here.
        </div>
      ) : (
        <ProjectGrid projects={projects} onDragged={onDragged} />
      )}
    </section>
  )
}

/**
 * Where the ungrouped cards live once there is at least one band to be outside of.
 *
 * It only exists to be somewhere a card can be dropped to come back *out* of a band —
 * the same gesture that put it in, aimed above the first rule. With no collapsibles on
 * the page this is not drawn at all and the grid stands on its own, exactly as it did
 * before any of this existed.
 */
export function LooseArea({
  projects,
  carried,
  onDragged,
  onRelease
}: {
  projects: ProjectSummary[]
  carried: ProjectSummary | null
  onDragged: (dragged: Dragged | null) => void
  onRelease: (projectId: string) => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  const accepts = carried !== null && carried.collapsibleId !== null

  return (
    <div
      className={`rounded-box transition ${over ? 'bg-primary/[0.07] ring-1 ring-primary/40' : ''}`}
      onDragOver={(e) => {
        if (!accepts) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        if (!accepts || !carried) return
        e.preventDefault()
        setOver(false)
        onRelease(carried.id)
      }}
    >
      {projects.length === 0 ? (
        <div className="hairline rounded-box border border-dashed px-3 py-5 text-center text-[12px] text-base-content/35">
          {accepts ? 'Drop here to take it out of its collapsible.' : 'Every project here is in a collapsible.'}
        </div>
      ) : (
        <ProjectGrid projects={projects} onDragged={onDragged} />
      )}
    </div>
  )
}
