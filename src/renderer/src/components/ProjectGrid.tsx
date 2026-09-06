import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { ProjectSummary } from '@shared/types'
import { useApiMutation } from '@/lib/api'
import { EASE } from '@/lib/motion'
import { ProjectCard } from './ProjectCard'
import type { Dragged } from './ProjectFolders'

/**
 * The grid of project cards, and the one place they can be put in an order.
 *
 * Arranging them by hand is filing, not state — the same allowance a folder gets, and
 * for the same reason: nothing derives anything from it, so an arrangement that has
 * gone stale costs you a card in the wrong place rather than a wrong answer. Until one
 * is dragged the page is ordered exactly as it always was, pinned first and then by
 * what has moved lately; the first drop is what turns that into an order of your own,
 * and it is kept per folder because a position only means anything among neighbours.
 *
 * The gesture is the one already here — a project is dragged onto a folder to file it —
 * so a project dropped on another project takes its place instead. Nothing new has to
 * be learned, and the two never collide: folders are their own row, above this one.
 */

/** How long a card takes to slide out of the way. Long enough to be followed. */
const SLIDE = { duration: 0.22, ease: EASE } as const

/** A slot in the grid, measured from the grid's own corner. */
interface Slot {
  x: number
  y: number
  w: number
  h: number
}

export function ProjectGrid({
  projects,
  onDragged
}: {
  projects: ProjectSummary[]
  /** Told what is in the air, so folders and breadcrumbs can offer themselves. */
  onDragged: (dragged: Dragged | null) => void
}): React.JSX.Element {
  const reorder = useApiMutation('project:reorder')
  const reduced = useReducedMotion()
  const grid = useRef<HTMLDivElement>(null)

  /** The card in the air, or null. Only ever one of the cards on this page. */
  const [carried, setCarried] = useState<string | null>(null)

  /*
   * Whether the pointer has taken the card somewhere that is not this grid — a
   * collapsible, a folder, a crumb, or the empty page between them. All of those are
   * drops of their own, and while one of them is the answer this one is not: exactly
   * one place on the screen may be lit at a time, or the page is offering two landings
   * for a card that can only have one. So the cards close back up into the order they
   * were in and the outline comes off, leaving only the space the card is leaving
   * behind. Coming back over the grid picks the arrangement up again where it left off.
   */
  const [elsewhere, setElsewhere] = useState(false)

  /*
   * The order the page is drawing *while you are deciding*, which is not the order the
   * database is in until you let go. It is held in a ref as well as in state because
   * the drop and the last movement over a card can land in the same frame, and the
   * handler that writes has to see the arrangement the eye is looking at rather than
   * the one from the render before it.
   */
  const [preview, setPreview] = useState<string[] | null>(null)
  const previewRef = useRef<string[] | null>(null)
  const show = (next: string[] | null): void => {
    previewRef.current = next
    setPreview(next)
  }

  const ids = useMemo(() => projects.map((p) => p.id), [projects])
  const signature = ids.join(' ')

  /*
   * When the preview stops being the truth. Two ways out and no third: either the write
   * has landed and the data now agrees with what is on screen — at which point holding
   * the preview would only mean a stale copy quietly overriding the app — or the set
   * itself has changed underneath, because a project was created, archived, filed
   * elsewhere or made by the assistant while you were looking at it. Anything else and
   * the preview stands, which is what stops every card flicking back to where it was
   * for the frame between letting go and the answer arriving.
   */
  useEffect(() => {
    if (carried) return
    const held = previewRef.current
    if (!held) return
    const settled = held.length === ids.length && held.every((id, i) => id === ids[i])
    const sameSet = held.length === ids.length && held.every((id) => ids.includes(id))
    if (settled || !sameSet) show(null)
  }, [signature, carried, ids])

  /*
   * What is actually drawn: the preview, then anything the preview has never heard of
   * appended rather than dropped. A card that arrives mid-drag is worth showing in the
   * wrong place for a moment; it is never worth not showing at all.
   */
  const drawn = useMemo(() => {
    if (!preview) return projects
    const byId = new Map(projects.map((p) => [p.id, p]))
    const out: ProjectSummary[] = []
    for (const id of preview) {
      const project = byId.get(id)
      if (project) {
        out.push(project)
        byId.delete(id)
      }
    }
    return [...out, ...projects.filter((p) => byId.has(p.id))]
  }, [preview, projects])

  /*
   * The grid measured once, as it was when the card came off it.
   *
   * Which slot the pointer is over is answered from these rather than by asking the
   * browser what is under it, and that is the whole reason the grid does not shiver.
   * The cards are moving — that is the point of the animation — so for a fifth of a
   * second after every swap the card under the pointer is one that has not finished
   * leaving, sitting at an index it is no longer at. Reading that back is an offer to
   * swap straight back, and then again, for as long as you hold still. The slots
   * themselves never move: only which card is in them does.
   *
   * Measured from the grid's own corner rather than the window's, so scrolling the page
   * mid-drag cannot pull the answer out from under it.
   */
  const slots = useRef<Slot[]>([])
  const measure = (): void => {
    const box = grid.current?.getBoundingClientRect()
    if (!grid.current || !box) return
    slots.current = Array.from(grid.current.children).map((child) => {
      const r = child.getBoundingClientRect()
      return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }
    })
  }

  /** The slot the pointer is in, or null for the gaps between them. */
  const slotAt = (clientX: number, clientY: number): number | null => {
    const box = grid.current?.getBoundingClientRect()
    if (!box) return null
    const x = clientX - box.left
    const y = clientY - box.top
    const found = slots.current.findIndex(
      (s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h
    )
    return found < 0 ? null : found
  }

  const lift = (id: string): void => {
    measure()
    setCarried(id)
    setElsewhere(false)
    show(ids.slice())
    onDragged({ kind: 'project', id })
  }

  /**
   * Passing over a slot takes it. The grid is uniform, so there is no half of a card to
   * aim at and nothing to choose between: the slot you are over is the slot you would
   * get, and everything between there and where the card came from shuffles along by
   * one to make room.
   */
  const over = (slot: number): void => {
    if (!carried) return
    const from = previewRef.current ?? ids
    const wants = Math.min(slot, from.length - 1)
    const was = from.indexOf(carried)
    if (was < 0 || was === wants) return
    const next = from.slice()
    next.splice(was, 1)
    next.splice(wants, 0, carried)
    show(next)
  }

  /*
   * A drop on the grid is the only thing that writes. A drop on a folder is a different
   * gesture handled somewhere else entirely, and letting go over nothing at all —
   * outside the window, or on Escape — has to leave the page as it was. That is what
   * this flag is for: the browser sends `dragend` either way, and only a real drop
   * turns it on first.
   */
  const dropped = useRef(false)

  const release = (): void => {
    setCarried(null)
    setElsewhere(false)
    onDragged(null)
    if (!dropped.current) show(null)
    dropped.current = false
  }

  return (
    <div
      ref={grid}
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      onDragOver={(e) => {
        if (!carried) return
        // Without this the drop is refused and the card flies back to where it started.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setElsewhere(false)
        const slot = slotAt(e.clientX, e.clientY)
        if (slot !== null) over(slot)
      }}
      /*
       * Leaving hands the drag over to whatever is out there. The guard is the usual
       * one: `dragleave` bubbles, so moving from one card to the next fires it on the
       * grid as well, and only a related target the grid does not contain — including
       * none at all, which is how leaving the window arrives — is really a departure.
       */
      onDragLeave={(e) => {
        if (!carried) return
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setElsewhere(true)
        show(ids.slice())
      }}
      onDrop={(e) => {
        if (!carried) return
        e.preventDefault()
        dropped.current = true
        const held = previewRef.current
        if (held && held.some((id, i) => id !== ids[i])) reorder.mutate({ ids: held })
      }}
    >
      {drawn.map((project) => (
        <motion.div
          key={project.id}
          /*
           * Position only. Every card is the same size, so there is nothing about their
           * shape to animate, and asking for the whole layout animation is what makes
           * one stretch on its way past its neighbours.
           */
          layout={reduced ? false : 'position'}
          transition={SLIDE}
          className="relative"
        >
          <Carryable
            project={project}
            carried={carried === project.id}
            landing={carried === project.id && !elsewhere}
            onLift={() => lift(project.id)}
            onRelease={release}
          />
        </motion.div>
      ))}
    </div>
  )
}

/**
 * A card you pick up.
 *
 * The card inside is a link with its own dragging turned off, so this is the drag
 * source and the browser's drag image is a picture of the card itself — the thing you
 * grabbed follows the pointer, rather than a ghost of a URL.
 *
 * It empties itself *on the next frame* rather than immediately, and that is not a
 * detail: the drag image is snapshotted at the end of the `dragstart` event, so hiding
 * the card now would put the empty slot into the picture as well and leave you dragging
 * nothing at all. One frame later the snapshot has been taken, and what is left behind
 * is the outline of where it will land — which then travels through the grid ahead of
 * the pointer for as long as you hold on to it.
 *
 * The drag handlers are on a plain element inside the animated one on purpose: a motion
 * component spells `onDragStart` differently, for dragging of its own.
 */
function Carryable({
  project,
  carried,
  landing,
  onLift,
  onRelease
}: {
  project: ProjectSummary
  /** This is the card in the air, so the slot it left is held open where it stands. */
  carried: boolean
  /** And this grid is still where it would land, so that slot is drawn as the landing. */
  landing: boolean
  onLift: () => void
  onRelease: () => void
}): React.JSX.Element {
  const [emptied, setEmptied] = useState(false)
  const away = emptied && carried

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onLift()
        requestAnimationFrame(() => setEmptied(true))
      }}
      onDragEnd={() => {
        setEmptied(false)
        onRelease()
      }}
      className="cursor-grab active:cursor-grabbing"
    >
      {/* Hidden rather than unmounted: the slot it leaves behind is the right size
          because the card is still in it, holding it open. */}
      <div className={away ? 'invisible' : ''}>
        <ProjectCard project={project} />
      </div>
      {away && landing && (
        <span className="pointer-events-none absolute inset-0 rounded-box border-2 border-dashed border-primary/40 bg-primary/[0.06]" />
      )}
    </div>
  )
}
