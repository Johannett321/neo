import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  animate,
  motion,
  motionValue,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type Transition
} from 'framer-motion'
import type { CastMember, TeamCanvas, TeamChart, TeamNode } from '@shared/types'
import { call, useApi, useApiMutation } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace'
import { useContextMenu, type MenuItem } from '@/lib/contextMenu'
import { useToast } from '@/lib/toast'
import { EASE } from '@/lib/motion'
import { Icon, type IconName } from '@/components/Icon'
import { RoleInput, formatRoles, parseRoles } from '@/components/RoleInput'
import {
  BoxCard,
  Burst,
  Connector,
  PersonCard,
  StartChoices,
  Tray,
  type NodeMotion
} from '@/components/team/pieces'
import {
  CARD_H,
  CARD_W,
  EMPTY_CHART,
  GRID,
  V_GAP,
  applyDrop,
  applyDropAll,
  bounds,
  boxesTemplate,
  carried,
  copySelection,
  describeDrop,
  groupIntoBox,
  layout,
  pasteClip,
  readClip,
  readingOrder,
  removeAll,
  sanitize,
  selectionJoiners,
  selectionRoots,
  separate,
  slotIndex,
  snap,
  tidy,
  treeTemplate,
  uid,
  type DropTarget,
  type Layout,
  type Rect,
  type TeamClip
} from '@/lib/team'
import { CastMemberModal } from '@/components/project/CastMemberModal'
import { useProject } from './ProjectLayout'

/*
 * The project's team, drawn — see lib/team.ts for what the drawing means. This file is
 * the hands: a pannable, zoomable board, a list of the project's people to drag from,
 * and the feedback that makes building it feel like handling things rather than
 * filling in a form.
 *
 * Every node's place on screen is four motion values (x, y, width, height) held here
 * and handed down, and the layout is only ever a *target* for them. A drop therefore
 * never jumps: the card springs from wherever your hand left it to wherever the tree
 * wants it, the cards around it part and close with the same spring, and the lines
 * between them are drawn from the very same numbers, so they cannot lag.
 *
 * While something is held, the board draws what letting go *would* do — `applyDrop`
 * on a copy — so the gap opens where the card will land and the dashed line runs to
 * whoever it will report to. Hit-testing is done against the board as it was when the
 * drag began, minus what is being carried, so targets never slide out from under the
 * pointer as the preview rearranges them.
 *
 * Several things can be held at once. Shift-, ⌘- or Ctrl-click adds to the selection (or
 * takes back out), and the same modifier dragged across empty board draws a marquee —
 * a plain drag on the board stays a pan, because that is what the board is for most of
 * the time. Whatever is selected moves together, and every gesture on it (a drop, ⌫,
 * ⌘G, a paste) is one step for undo.
 */

/**
 * What ⌘C last took, kept in the window as well as on the system clipboard: the menu's
 * Paste cannot read the system clipboard (the app is not granted it), and this outlives
 * moving from one project to another.
 */
let inAppClip: { text: string; clip: TeamClip } | null = null
/** Pasting the same thing again beside its originals steps further out each time. */
let pasteRun = { text: '', n: 0 }

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** Room kept clear on the right for the people list when the view is fitted. */
const TRAY_SPACE = 252
const TOOLBAR_SPACE = 56
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2
const DRAG_THRESHOLD = 4

const REFLOW: Transition = { type: 'spring', stiffness: 420, damping: 36, mass: 0.8 }
/** Landing: a touch of overshoot, so a drop settles rather than stops. */
const SETTLE: Transition = { type: 'spring', stiffness: 360, damping: 19, mass: 0.9 }
const STILL: Transition = { duration: 0.12, ease: EASE }

interface Drag {
  started: boolean
  startClient: { x: number; y: number }
  lastClient: { x: number; y: number }
  /** A node already on the board, or a new card from the list. */
  nodeId: string | null
  fresh: TeamNode | null
  member: CastMember | null
  /** Where the pointer holds the card, from its top-left corner, in board units. */
  grab: { x: number; y: number }
  pointer: { x: number; y: number }
  overTray: boolean
  target: DropTarget | null
  tilt: number
  /** Fixed when the drag begins. */
  carriedIds: Set<string>
  hit: Layout | null
  hitChart: TeamChart | null
  /** What moves by itself (`selectionRoots`), and what goes in if it is dropped in a box. */
  roots: string[]
  joiners: string[]
  /** The board as it was drawn when the drag began. */
  from: Layout | null
  /** A click that does not become a drag: narrow the selection to this, or take this out of it. */
  collapseTo: string | null
  toggleOff: string | null
}

interface Marquee {
  /** Screen points, relative to the board's corner, for drawing. */
  sx0: number
  sy0: number
  sx1: number
  sy1: number
  /** What was selected before it began, kept and added to. */
  before: Set<string>
}

interface Pan {
  startClient: { x: number; y: number }
  origin: { x: number; y: number }
  moved: boolean
}

interface BurstItem {
  id: string
  x: number
  y: number
  tone: 'primary' | 'muted'
}

const inside = (r: Rect | undefined, p: { x: number; y: number }, pad = 0): boolean =>
  !!r && p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad

/** "Ann", "Ann and Bo", "Ann, Bo and 3 more". */
const listNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : names.length <= 3
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`

const typing = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

export function ProjectTeam(): React.JSX.Element {
  const { project, cast, tasks } = useProject()
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const client = useQueryClient()
  const openMenu = useContextMenu()
  const reduced = useReducedMotion() ?? false
  const { data: remote } = useApi('team:get', { projectId: project.id })
  const roleSuggestions = useApi('membership:roles', { workspaceId: workspace.id })
  const saveMembership = useApiMutation('membership:save')
  const removeMember = useApiMutation('membership:delete')
  /*
   * The team chart is the project's people screen — there is no list beside it — so
   * adding someone, and editing who they are on this project, open from here. `member`
   * null is adding.
   */
  const [castModal, setCastModal] = useState<{ member: CastMember | null } | null>(null)

  /** What can be done about a person on this project, from their card or their row in the list. */
  const memberItems = (member: CastMember): MenuItem[] => [
    { label: 'Open profile', icon: 'external', onSelect: () => navigate(`/people/${member.personId}`) },
    { label: 'Edit details…', icon: 'edit', onSelect: () => setCastModal({ member }) },
    ...(member.isMe
      ? []
      : ([
          'separator',
          {
            label: 'Remove from project',
            icon: 'trash',
            danger: true,
            confirm: {
              title: `Remove ${member.name} from this project?`,
              body: 'They come off the chart, and stay in the workspace and on any other project they are part of.',
              confirmLabel: 'Remove'
            },
            onSelect: () => removeMember.mutate({ id: member.id })
          }
        ] as MenuItem[]))
  ]

  /* ---------------------------------------------------------------- the drawing */

  const [chart, setChart] = useState<TeamChart>(EMPTY_CHART)
  const [loaded, setLoaded] = useState(false)
  const display = useMemo(() => sanitize(chart, cast), [chart, cast])
  const displayRef = useRef(display)
  displayRef.current = display

  const past = useRef<TeamChart[]>([])
  const future = useRef<TeamChart[]>([])
  const [, setHistoryTick] = useState(0)

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef(false)
  /** The `updatedAt` of the drawing this window last wrote or read. */
  const stamp = useRef<string | null>(null)
  const latest = useRef<TeamChart>(EMPTY_CHART)

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const data = latest.current
    try {
      const saved: TeamCanvas = await call('team:save', { projectId: project.id, data })
      stamp.current = saved.updatedAt
      if (latest.current === data) pending.current = false
      // Straight into the cache rather than through a mutation: arranging cards is not
      // a reason to refetch every other screen.
      client.setQueryData(['team:get', { projectId: project.id }], saved)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [client, project.id])

  const scheduleSave = useCallback(
    (next: TeamChart) => {
      latest.current = next
      pending.current = true
      setSaveState('saving')
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(), 450)
    },
    [flush]
  )

  // Leaving the tab mid-arrangement still keeps it.
  useEffect(
    () => () => {
      if (pending.current) void flush()
    },
    [flush]
  )

  const commit = useCallback(
    (next: TeamChart) => {
      const prev = displayRef.current
      if (JSON.stringify(prev.nodes) === JSON.stringify(next.nodes)) return
      past.current.push(prev)
      if (past.current.length > 100) past.current.shift()
      future.current = []
      setHistoryTick((t) => t + 1)
      setChart(next)
      displayRef.current = sanitize(next, cast)
      scheduleSave(next)
    },
    [cast, scheduleSave]
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(displayRef.current)
    setHistoryTick((t) => t + 1)
    setChart(prev)
    scheduleSave(prev)
  }, [scheduleSave])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(displayRef.current)
    setHistoryTick((t) => t + 1)
    setChart(next)
    scheduleSave(next)
  }, [scheduleSave])

  /* ---------------------------------------------------------------- the view */

  const containerRef = useRef<HTMLDivElement>(null)
  const trayRef = useRef<HTMLDivElement>(null)
  const vx = useMotionValue(0)
  const vy = useMotionValue(0)
  const vz = useMotionValue(1)
  const dotSize = useTransform(vz, (z) => 24 * z)
  const backgroundSize = useMotionTemplate`${dotSize}px ${dotSize}px`
  const backgroundPosition = useMotionTemplate`${vx}px ${vy}px`
  const zoomLabel = useTransform(vz, (z) => `${Math.round(z * 100)}%`)

  const toBoard = useCallback(
    (clientX: number, clientY: number, view?: { x: number; y: number; z: number }) => {
      const rect = containerRef.current?.getBoundingClientRect()
      const v = view ?? { x: vx.get(), y: vy.get(), z: vz.get() }
      return { x: (clientX - (rect?.left ?? 0) - v.x) / v.z, y: (clientY - (rect?.top ?? 0) - v.y) / v.z }
    },
    [vx, vy, vz]
  )

  /** The view that shows `b` whole, in the part of the board the list does not cover. */
  const viewFor = useCallback((b: Rect | null): { x: number; y: number; z: number } => {
    const rect = containerRef.current?.getBoundingClientRect()
    const w = Math.max(200, (rect?.width ?? 900) - TRAY_SPACE)
    const h = Math.max(200, (rect?.height ?? 600) - TOOLBAR_SPACE)
    if (!b) return { x: w / 2 - CARD_W / 2, y: TOOLBAR_SPACE + 80, z: 1 }
    const pad = 48
    const z = Math.min(1.1, Math.max(MIN_ZOOM, Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h)))
    return { x: (w - b.w * z) / 2 - b.x * z, y: TOOLBAR_SPACE + (h - b.h * z) / 2 - b.y * z, z }
  }, [])

  const moveView = useCallback(
    (v: { x: number; y: number; z: number }, animated: boolean) => {
      if (!animated || reduced) {
        vx.set(v.x)
        vy.set(v.y)
        vz.set(v.z)
        return
      }
      const t = { duration: 0.55, ease: EASE }
      animate(vx, v.x, t)
      animate(vy, v.y, t)
      animate(vz, v.z, t)
    },
    [reduced, vx, vy, vz]
  )

  const fit = useCallback(
    (animated = true) => moveView(viewFor(bounds(layout(displayRef.current))), animated),
    [moveView, viewFor]
  )

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = containerRef.current?.getBoundingClientRect()
      const cx = ((rect?.width ?? 0) - TRAY_SPACE) / 2
      const cy = (rect?.height ?? 0) / 2
      const z = vz.get()
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor))
      moveView({ x: cx - ((cx - vx.get()) * nz) / z, y: cy - ((cy - vy.get()) * nz) / z, z: nz }, true)
    },
    [moveView, vx, vy, vz]
  )

  /** The middle of what you can see, on the board. */
  const viewCentre = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return toBoard(rect.left + (rect.width - TRAY_SPACE) / 2, rect.top + rect.height / 2)
  }, [toBoard])

  // Trackpad: two fingers pan, a pinch (which arrives as ctrl + wheel) zooms about the
  // pointer. Native and non-passive, because a React wheel handler cannot stop the page.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const t = e.target as HTMLElement
      if (t.closest('[data-tray]') || t.closest('[data-popover]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const z = vz.get()
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-e.deltaY * 0.0085)))
        vx.set(cx - ((cx - vx.get()) * nz) / z)
        vy.set(cy - ((cy - vy.get()) * nz) / z)
        vz.set(nz)
      } else {
        vx.set(vx.get() - e.deltaX)
        vy.set(vy.get() - e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [vx, vy, vz])

  /* ---------------------------------------------------------------- loading */

  useEffect(() => {
    if (!remote) return
    if (!loaded) {
      stamp.current = remote.updatedAt
      latest.current = remote.data
      setChart(remote.data)
      displayRef.current = sanitize(remote.data, cast)
      setLoaded(true)
      requestAnimationFrame(() => fit(false))
      return
    }
    // Drawn on another device: take it, unless this window has something unsaved.
    if (remote.updatedAt !== stamp.current && !pending.current) {
      stamp.current = remote.updatedAt
      latest.current = remote.data
      setChart(remote.data)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote])

  /* ---------------------------------------------------------------- who is who */

  const members = useMemo(() => new Map(cast.map((m) => [m.personId, m])), [cast])
  const openCounts = useMemo(() => {
    const out = new Map<string, number>()
    for (const t of tasks) {
      if (t.status === 'open' && t.assigneePersonId) out.set(t.assigneePersonId, (out.get(t.assigneePersonId) ?? 0) + 1)
    }
    return out
  }, [tasks])
  const placed = useMemo(() => {
    const out = new Map<string, number>()
    for (const n of display.nodes) if (n.personId) out.set(n.personId, (out.get(n.personId) ?? 0) + 1)
    return out
  }, [display])

  const nameOf = useCallback(
    (id: string, chartToRead: TeamChart = displayRef.current): string => {
      const n = chartToRead.nodes.find((x) => x.id === id)
      if (!n) return 'it'
      return n.kind === 'box' ? n.label || 'the box' : (members.get(n.personId ?? '')?.name ?? 'them')
    },
    [members]
  )

  /* ---------------------------------------------------------------- selection and editing */

  const [selection, setSelectionState] = useState<Set<string>>(() => new Set())
  const selRef = useRef(selection)
  const select = useCallback((ids: Iterable<string>) => {
    const next = new Set(ids)
    selRef.current = next
    setSelectionState(next)
  }, [])
  /** The selection as it stands on the board now — an undo can take a selected node away. */
  const selected = useMemo(() => {
    const on = new Set(display.nodes.map((n) => n.id))
    return new Set([...selection].filter((id) => on.has(id)))
  }, [selection, display])
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const single = selected.size === 1 ? [...selected][0] : null
  const [editingRole, setEditingRole] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [bursts, setBursts] = useState<BurstItem[]>([])
  const toast = useToast()

  const burst = useCallback(
    (x: number, y: number, tone: BurstItem['tone'] = 'primary') => {
      if (reduced) return
      const id = uid()
      setBursts((b) => [...b, { id, x, y, tone }])
      setTimeout(() => setBursts((b) => b.filter((i) => i.id !== id)), 900)
    },
    [reduced]
  )

  /* ---------------------------------------------------------------- dragging */

  const dragRef = useRef<Drag | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const frame = useRef<number | null>(null)
  const panRef = useRef<Pan | null>(null)
  const settleTilt = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justDropped = useRef<Set<string>>(new Set())
  const spawn = useRef<Map<string, { x: number; y: number; delay: number }>>(new Map())
  /** Things that have just been pasted, and how long each waits before popping in. */
  const popIn = useRef<Map<string, number>>(new Map())

  const publish = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setDrag(dragRef.current ? { ...dragRef.current } : null)
    })
  }, [])

  const findTarget = useCallback((d: Drag): DropTarget | null => {
    if (d.overTray) return d.nodeId ? { kind: 'remove' } : null
    const hit = d.hit
    const board = d.hitChart
    if (!hit || !board) return null
    const p = d.pointer
    const byId = new Map(board.nodes.map((n) => [n.id, n]))
    const depth = (id: string): number => {
      let k = 0
      for (let cur = byId.get(id); cur?.boxId && k < 256; cur = byId.get(cur.boxId)) k++
      return k
    }

    const childIndex = (parentId: string): number =>
      board.nodes.filter((n) => n.parentId === parentId && !n.boxId).filter((n) => {
        const r = hit.rects.get(n.id)
        return r && r.x + r.w / 2 < p.x
      }).length
    // Into a box, whatever is held; onto a card, under it.
    const onto = (n: TeamNode): DropTarget =>
      n.kind === 'box'
        ? { kind: 'box', id: n.id, index: slotIndex(hit, n.id, p) }
        : { kind: 'parent', id: n.id, index: childIndex(n.id) }

    // A card first: it is the smallest thing, and sits on top of a box. A card in a box
    // means that box — the innermost one, since the card is in it.
    for (const n of board.nodes) {
      if (n.kind !== 'person' || !inside(hit.rects.get(n.id), p, 6)) continue
      if (n.boxId) {
        const box = byId.get(n.boxId)
        if (box) return onto(box)
      }
      return onto(n)
    }
    // Then the innermost box under the pointer.
    let innermost: { n: TeamNode; depth: number } | null = null
    for (const n of board.nodes) {
      if (n.kind !== 'box' || !inside(hit.rects.get(n.id), p, 8)) continue
      const k = depth(n.id)
      if (!innermost || k > innermost.depth) innermost = { n, depth: k }
    }
    if (innermost) return onto(innermost.n)
    // The space just under a card is the magnet: aim below someone to hang under them.
    let best: { n: TeamNode; dy: number } | null = null
    for (const n of board.nodes) {
      if (n.boxId) continue
      const r = hit.rects.get(n.id)
      if (!r) continue
      const zone = { x: r.x - 16, y: r.y + r.h, w: r.w + 32, h: V_GAP + CARD_H * 0.6 }
      if (inside(zone, p) && (!best || p.y - zone.y < best.dy)) best = { n, dy: p.y - zone.y }
    }
    if (best) return { kind: 'parent', id: best.n.id, index: childIndex(best.n.id) }
    return { kind: 'free', x: snap(p.x - d.grab.x), y: snap(p.y - d.grab.y) }
  }, [])

  const begin = useCallback((d: Drag) => {
    const board = displayRef.current
    const from = layout(board)
    if (d.fresh) {
      d.roots = [d.fresh.id]
      d.joiners = [d.fresh.id]
      d.carriedIds = new Set([d.fresh.id])
    } else {
      // Holding one of several selected holds all of them.
      const sel = selRef.current.has(d.nodeId!) ? selRef.current : new Set([d.nodeId!])
      d.roots = readingOrder(selectionRoots(board, sel), from)
      d.joiners = readingOrder(selectionJoiners(board, sel), from)
      d.carriedIds = new Set()
      for (const r of d.roots) carried(board, r).forEach((id) => d.carriedIds.add(id))
    }
    const hitChart: TeamChart = { version: 1, nodes: board.nodes.filter((n) => !d.carriedIds.has(n.id)) }
    d.started = true
    d.from = from
    d.hitChart = hitChart
    d.hit = layout(hitChart)
    setEditingRole(null)
    setRenaming(null)
  }, [])

  /**
   * The board if `d` were let go at `target`. One thing or a whole selection: onto a
   * card the roots line up under it, into a box everything selected goes in, and on
   * open board each root keeps where it stood relative to the one in your hand.
   */
  const land = useCallback((board: TeamChart, d: Drag, target: DropTarget): TeamChart => {
    if (d.fresh) return applyDrop(board, d.fresh, target)
    if (target.kind === 'box') return applyDropAll(board, d.joiners, target)
    if (target.kind === 'free') {
      const own = d.from?.rects.get(d.nodeId!)
      const dx = own ? target.x - own.x : 0
      const dy = own ? target.y - own.y : 0
      const at = new Map(
        d.roots.map((id) => {
          const r = d.from?.rects.get(id)
          return [id, { x: snap((r?.x ?? target.x) + dx), y: snap((r?.y ?? target.y) + dy) }] as const
        })
      )
      return applyDropAll(board, d.roots, target, at)
    }
    return applyDropAll(board, d.roots, target)
  }, [])

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!d.started) {
        if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < DRAG_THRESHOLD) return
        begin(d)
      }
      const vxDelta = e.clientX - d.lastClient.x
      d.tilt = reduced ? 0 : Math.max(-6, Math.min(6, d.tilt * 0.6 + vxDelta * 0.35))
      d.lastClient = { x: e.clientX, y: e.clientY }
      d.pointer = toBoard(e.clientX, e.clientY)
      const tray = trayRef.current?.getBoundingClientRect()
      d.overTray = !!tray && e.clientX >= tray.left && e.clientX <= tray.right && e.clientY >= tray.top && e.clientY <= tray.bottom
      d.target = findTarget(d)
      publish()
      // A card held still straightens up.
      if (settleTilt.current) clearTimeout(settleTilt.current)
      settleTilt.current = setTimeout(() => {
        if (dragRef.current && dragRef.current.tilt !== 0) {
          dragRef.current.tilt = 0
          publish()
        }
      }, 90)
    },
    [begin, findTarget, publish, reduced, toBoard]
  )

  const cancelDrag = useCallback(() => {
    dragRef.current = null
    setDrag(null)
  }, [])

  // Declared before onUp uses it; set below once `drop` exists.
  const dropRef = useRef<(d: Drag) => void>(() => undefined)
  const clickTrayRef = useRef<(m: CastMember) => void>(() => undefined)

  const onUp = useCallback(
    (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      if (!d) return
      if (e.type === 'pointercancel') return cancelDrag()
      if (d.started) {
        d.pointer = toBoard(e.clientX, e.clientY)
        dropRef.current(d)
      } else {
        dragRef.current = null
        if (d.fresh && d.member) clickTrayRef.current(d.member)
        else if (d.toggleOff) select([...selRef.current].filter((id) => id !== d.toggleOff))
        else if (d.collapseTo) select([d.collapseTo])
      }
    },
    [cancelDrag, onMove, select, toBoard]
  )

  const listen = useCallback(() => {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [onMove, onUp])

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    },
    [onMove, onUp]
  )

  const blankDrag = (): Omit<Drag, 'nodeId' | 'fresh' | 'member' | 'grab' | 'startClient' | 'lastClient' | 'pointer'> => ({
    started: false,
    overTray: false,
    target: null,
    tilt: 0,
    carriedIds: new Set(),
    hit: null,
    hitChart: null,
    roots: [],
    joiners: [],
    from: null,
    collapseTo: null,
    toggleOff: null
  })

  /* ---------------------------------------------------------------- what is drawn where */

  const base = useMemo(() => layout(display), [display])
  const moverId = drag?.started ? (drag.nodeId ?? drag.fresh?.id ?? null) : null

  const preview = useMemo(
    () =>
      drag?.started && drag.target
        ? separate(
            land(display, drag, drag.target),
            drag.target.kind === 'remove' ? null : (drag.fresh?.id ?? drag.roots[0] ?? null)
          )
        : display,
    // The pointer moving inside one target does not change the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display, drag?.started, drag?.fresh, drag?.roots, JSON.stringify(drag?.target ?? null)]
  )
  const previewLayout = useMemo(() => (preview === display ? base : layout(preview)), [preview, display, base])

  const movingIds = drag?.started ? drag.carriedIds : null
  /** What lifts off the board: the roots of what is held, each with its own shadow. */
  const liftedIds = drag?.started ? new Set(drag.fresh ? [drag.fresh.id] : drag.roots) : null
  const rects = new Map(previewLayout.rects)
  let referenceIsBase = false
  if (drag?.started && moverId && movingIds) {
    const ref = previewLayout.rects.has(moverId) ? previewLayout : base
    referenceIsBase = ref === base
    const tl = { x: drag.pointer.x - drag.grab.x, y: drag.pointer.y - drag.grab.y }
    const own = ref.rects.get(moverId) ?? { x: tl.x, y: tl.y, w: CARD_W, h: CARD_H }
    // The magnet: once a target has you, the card leans a little toward its slot.
    let lean = tl
    const slot = previewLayout.rects.get(moverId)
    if (slot && drag.target && (drag.target.kind === 'parent' || drag.target.kind === 'box') && !reduced) {
      lean = { x: tl.x + (slot.x - tl.x) * 0.16, y: tl.y + (slot.y - tl.y) * 0.16 }
    }
    const dx = lean.x - own.x
    const dy = lean.y - own.y
    for (const id of movingIds) {
      const r = ref.rects.get(id) ?? base.rects.get(id) ?? (id === moverId ? own : undefined)
      if (r) rects.set(id, { ...r, x: r.x + dx, y: r.y + dy })
    }
  }

  const nodeById = new Map<string, TeamNode>()
  for (const n of display.nodes) nodeById.set(n.id, n)
  for (const n of preview.nodes) nodeById.set(n.id, n)
  if (drag?.fresh) nodeById.set(drag.fresh.id, drag.fresh)

  /** How deep each node sits in boxes, and how many people each box holds at any depth. */
  const depthOf = new Map<string, number>()
  const peopleIn = new Map<string, number>()
  const hasContents = new Set<string>()
  for (const n of nodeById.values()) {
    let k = 0
    if (n.boxId) hasContents.add(n.boxId)
    for (let up = n.boxId ? nodeById.get(n.boxId) : undefined; up && k < 256; up = up.boxId ? nodeById.get(up.boxId) : undefined) {
      k++
      if (n.kind === 'person') peopleIn.set(up.id, (peopleIn.get(up.id) ?? 0) + 1)
    }
    depthOf.set(n.id, k)
  }

  const edges = [...previewLayout.edges]
  if (referenceIsBase && movingIds) {
    for (const e of base.edges) if (movingIds.has(e.from) && movingIds.has(e.to)) edges.push(e)
  }

  /* ---------------------------------------------------------------- motion */

  const motions = useRef(new Map<string, NodeMotion>())
  const targets = useRef(new Map<string, Rect>())
  const motionFor = (id: string, at: Rect): NodeMotion => {
    let m = motions.current.get(id)
    if (!m) {
      const from = spawn.current.get(id)
      m = {
        x: motionValue(from ? from.x : at.x),
        y: motionValue(from ? from.y : at.y),
        w: motionValue(at.w),
        h: motionValue(at.h)
      }
      motions.current.set(id, m)
    }
    return m
  }
  rects.forEach((r, id) => motionFor(id, r))

  useLayoutEffect(() => {
    rects.forEach((r, id) => {
      const m = motionFor(id, r)
      if (movingIds?.has(id)) {
        m.x.set(r.x)
        m.y.set(r.y)
        m.w.set(r.w)
        m.h.set(r.h)
        targets.current.set(id, r)
        return
      }
      const last = targets.current.get(id)
      if (last && last.x === r.x && last.y === r.y && last.w === r.w && last.h === r.h) return
      targets.current.set(id, r)
      const from = spawn.current.get(id)
      spawn.current.delete(id)
      const t: Transition = reduced
        ? STILL
        : justDropped.current.has(id)
          ? SETTLE
          : from
            ? { ...SETTLE, delay: from.delay }
            : REFLOW
      if (!last && !from) {
        m.x.set(r.x)
        m.y.set(r.y)
        m.w.set(r.w)
        m.h.set(r.h)
        return
      }
      animate(m.x, r.x, t)
      animate(m.y, r.y, t)
      animate(m.w, r.w, t)
      animate(m.h, r.h, t)
    })
    justDropped.current.clear()
  })

  /* ---------------------------------------------------------------- letting go */

  const drop = useCallback(
    (d: Drag) => {
      dragRef.current = null
      const target = d.target
      if (!target || (!d.fresh && !d.roots.length)) {
        setDrag(null)
        return
      }
      const lead = d.fresh?.id ?? (target.kind === 'box' ? d.joiners[0] : d.roots[0])
      const next = separate(land(displayRef.current, d, target), target.kind === 'remove' ? null : lead)
      justDropped.current = new Set(d.carriedIds)
      commit(next)
      setDrag(null)
      if (target.kind === 'remove') {
        burst(d.pointer.x, d.pointer.y, 'muted')
        select([])
        return
      }
      if (d.fresh) select([d.fresh.id])
      const r = layout(sanitize(next, cast)).rects.get(lead)
      if (!r) return
      if (target.kind === 'parent') burst(r.x + r.w / 2, r.y, 'primary')
      else burst(r.x + r.w / 2, r.y + r.h / 2, 'primary')
    },
    [burst, cast, commit, land, select]
  )
  dropRef.current = drop

  /* ---------------------------------------------------------------- the gestures */

  const onNodePointerDown = (e: React.PointerEvent, id: string): void => {
    if (e.button !== 0 || typing(e.target)) return
    e.stopPropagation()
    const r = base.rects.get(id)
    if (!r) return
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const current = selRef.current
    let toggleOff: string | null = null
    let collapseTo: string | null = null
    if (additive) {
      // In, or (on a click that does not become a drag) back out again.
      if (current.has(id)) toggleOff = id
      else select([...current, id])
    } else if (current.has(id) && current.size > 1) {
      // Pressing one of several keeps them all, so they can be dragged together; a
      // plain click narrows to this one.
      collapseTo = id
    } else {
      select([id])
    }
    if (editingRole && editingRole !== id) setEditingRole(null)
    const p = toBoard(e.clientX, e.clientY)
    dragRef.current = {
      ...blankDrag(),
      nodeId: id,
      fresh: null,
      member: null,
      grab: { x: p.x - r.x, y: p.y - r.y },
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      pointer: p,
      toggleOff,
      collapseTo
    }
    listen()
  }

  const onTrayPick = (e: React.PointerEvent, member: CastMember): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const node: TeamNode = { id: uid(), kind: 'person', personId: member.personId, x: 0, y: 0 }
    dragRef.current = {
      ...blankDrag(),
      nodeId: null,
      fresh: node,
      member,
      grab: { x: 30, y: CARD_H / 2 },
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      pointer: toBoard(e.clientX, e.clientY)
    }
    listen()
  }

  /**
   * A click in the list. Somebody already drawn is found and shown; somebody not yet
   * drawn is placed — under whoever is selected, into the selected box, or in the
   * middle of the view.
   */
  const onTrayClick = (member: CastMember): void => {
    const board = displayRef.current
    const existing = board.nodes.find((n) => n.personId === member.personId)
    if (existing) {
      const r = layout(board).rects.get(existing.id)
      if (r) {
        const rect = containerRef.current?.getBoundingClientRect()
        const z = Math.max(vz.get(), 0.8)
        const w = (rect?.width ?? 900) - TRAY_SPACE
        const h = rect?.height ?? 600
        moveView({ x: w / 2 - (r.x + r.w / 2) * z, y: h / 2 - (r.y + r.h / 2) * z, z }, true)
        select([existing.id])
        setTimeout(() => burst(r.x + r.w / 2, r.y + r.h / 2, 'primary'), reduced ? 0 : 420)
      }
      return
    }
    const node: TeamNode = { id: uid(), kind: 'person', personId: member.personId, x: 0, y: 0 }
    const sel = single ? board.nodes.find((n) => n.id === single) : undefined
    let target: DropTarget
    if (sel?.kind === 'box') target = { kind: 'box', id: sel.id, index: 999 }
    else if (sel?.boxId) target = { kind: 'box', id: sel.boxId, index: 999 }
    else if (sel) target = { kind: 'parent', id: sel.id, index: 999 }
    else {
      const c = viewCentre()
      target = { kind: 'free', x: snap(c.x - CARD_W / 2), y: snap(c.y - CARD_H / 2) }
    }
    const tray = trayRef.current?.getBoundingClientRect()
    if (tray && !reduced) {
      const from = toBoard(tray.left + 20, tray.top + 60)
      spawn.current.set(node.id, { ...from, delay: 0 })
    }
    const next = separate(applyDrop(board, node, target), node.id)
    commit(next)
    const r = layout(sanitize(next, cast)).rects.get(node.id)
    if (r) setTimeout(() => burst(r.x + r.w / 2, r.y + r.h / 2), reduced ? 0 : 260)
  }
  clickTrayRef.current = onTrayClick

  const addBox = (at?: { x: number; y: number }): void => {
    const c = at ?? viewCentre()
    const node: TeamNode = {
      id: uid(),
      kind: 'box',
      label: 'New box',
      x: snap(c.x - (CARD_W + 28) / 2),
      y: snap(c.y - 60)
    }
    commit({ version: 1, nodes: [...displayRef.current.nodes, node] })
    select([node.id])
    setRenaming(node.id)
    burst(c.x, c.y)
  }

  /** Off the chart, every one of them, as one step. A box's contents stay, in its place. */
  const takeOff = (ids: Iterable<string>): void => {
    const list = [...ids]
    if (!list.length) return
    commit(removeAll(displayRef.current, list, base))
    list.slice(0, 6).forEach((id, i) => {
      const r = base.rects.get(id)
      if (r) setTimeout(() => burst(r.x + r.w / 2, r.y + r.h / 2, 'muted'), reduced ? 0 : i * 40)
    })
    select([])
    setEditingRole(null)
  }

  /** Out of whatever box or tree they are in, a step down and to the right of where they were. */
  const standFree = (ids: Iterable<string>): void => {
    const board = displayRef.current
    const roots = readingOrder(selectionRoots(board, ids), base).filter((id) => {
      const n = board.nodes.find((x) => x.id === id)
      return n && (n.parentId || n.boxId)
    })
    if (!roots.length) return
    const at = new Map(
      roots.map((id) => {
        const r = base.rects.get(id)!
        return [id, { x: snap(r.x + 40), y: snap(r.y + CARD_H + 40) }] as const
      })
    )
    commit(separate(applyDropAll(board, roots, { kind: 'free', x: 0, y: 0 }, at), roots[0]))
  }

  const group = (ids: Iterable<string>): void => {
    const made = groupIntoBox(displayRef.current, ids, base)
    if (!made) return
    const next = separate(made.chart, made.boxId)
    commit(next)
    select([made.boxId])
    setRenaming(made.boxId)
    const r = layout(sanitize(next, cast)).rects.get(made.boxId)
    if (r) burst(r.x + r.w / 2, r.y + 19)
  }

  /* ---------------------------------------------------------------- copy and paste */

  const personName = useCallback((personId: string) => members.get(personId)?.name ?? 'Someone', [members])
  /** Where the pointer is on the board, or null when it is not over open board. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null)

  const clipOf = (ids: Iterable<string>): TeamClip | null =>
    copySelection(displayRef.current, ids, layout(displayRef.current), personName, project.id)

  /**
   * Put a clip on the board: at the pointer when it is over the board, else a step
   * beside the originals when they are on this board, else in the middle of the view.
   * What lands is selected and pops in; whoever is not on this project is left out
   * and named.
   */
  const pasteNow = (clip: TeamClip, key: string, at?: { x: number; y: number }): void => {
    const board = displayRef.current
    const onProject = new Set(cast.map((c) => c.personId))
    const originalsHere = clip.projectId === project.id && clip.nodes.some((n) => board.nodes.some((b) => b.id === n.id))
    let place: Parameters<typeof pasteClip>[2]
    const pointer = at ?? pointerAt.current
    if (pointer) place = { centre: pointer }
    else if (originalsHere) {
      if (pasteRun.text !== key) pasteRun = { text: key, n: 0 }
      pasteRun.n++
      place = { offset: { x: GRID * 2 * pasteRun.n, y: GRID * 2 * pasteRun.n } }
    } else place = { centre: viewCentre() }
    const { nodes, skipped } = pasteClip(clip, onProject, place)
    if (skipped.length) {
      const are = `${listNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} not on this project`
      toast({
        title: nodes.length ? `Pasted without ${skipped.length === 1 ? skipped[0] : `${skipped.length} people`}` : 'Nothing to paste here',
        detail: nodes.length
          ? skipped.length === 1 ? 'They are not on this project.' : `Not on this project: ${listNames(skipped)}`
          : `${are} — add them to it first.`,
        icon: 'people',
        tone: 'neutral'
      })
    }
    if (!nodes.length) return
    landPasted(nodes)
  }

  /** New nodes onto the board as one step, popping in one after another. */
  const landPasted = (nodes: TeamNode[], into?: { target: DropTarget; roots: string[] }): void => {
    let next: TeamChart = { version: 1, nodes: [...displayRef.current.nodes, ...nodes] }
    if (into) next = applyDropAll(next, into.roots, into.target)
    const first = nodes.find((n) => !n.parentId && !n.boxId)?.id ?? nodes[0].id
    next = separate(next, first)
    if (!reduced) {
      nodes.forEach((n, i) => popIn.current.set(n.id, Math.min(i, 14) * 0.035))
      setTimeout(() => nodes.forEach((n) => popIn.current.delete(n.id)), 1200)
    }
    commit(next)
    select(nodes.map((n) => n.id))
  }

  const copyNow = (cut: boolean): TeamClip | null => {
    const ids = selectedRef.current
    if (!ids.size) return null
    const clip = clipOf(ids)
    if (!clip) return null
    const text = JSON.stringify(clip)
    inAppClip = { text, clip }
    pasteRun = { text, n: 0 }
    if (cut) takeOff(ids)
    return clip
  }

  /**
   * ⌘D: a copy beside the originals that stays where they were — in the same box, or
   * under the same person — and never touches the clipboard.
   */
  const duplicate = (ids: Iterable<string>): void => {
    const board = displayRef.current
    const list = [...ids]
    const clip = clipOf(list)
    if (!clip) return
    const { nodes } = pasteClip(clip, new Set(cast.map((c) => c.personId)), { offset: { x: GRID * 2, y: GRID * 2 } })
    if (!nodes.length) return
    // Where the originals all sat together, the copies go in right after them.
    const joiners = selectionJoiners(board, list)
    const byId = new Map(board.nodes.map((n) => [n.id, n]))
    const first = byId.get(joiners[0])
    const sameBox = first?.boxId && joiners.every((id) => byId.get(id)?.boxId === first.boxId) ? first.boxId : null
    const sameParent = !sameBox && first?.parentId && joiners.every((id) => !byId.get(id)?.boxId && byId.get(id)?.parentId === first.parentId)
      ? first.parentId
      : null
    if (sameBox || sameParent) {
      const roots = nodes.filter((n) => !n.parentId && !n.boxId)
      const siblings = board.nodes.filter((n) => (sameBox ? n.boxId === sameBox : !n.boxId && n.parentId === sameParent))
      const after = Math.max(...joiners.map((id) => siblings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).findIndex((s) => s.id === id))) + 1
      const target: DropTarget = sameBox ? { kind: 'box', id: sameBox, index: after } : { kind: 'parent', id: sameParent!, index: after }
      landPasted(nodes, { target, roots: readingOrder(roots.map((n) => n.id), layout({ version: 1, nodes })) })
    } else {
      landPasted(nodes)
    }
  }

  // ⌘C, ⌘X and ⌘V arrive as the clipboard's own events (from the keyboard or the Edit
  // menu alike), which is also the only way to write and read the system clipboard
  // without asking for it. Never while a field has focus or text is selected.
  useEffect(() => {
    const busy = (e: Event): boolean =>
      typing(e.target) || typing(document.activeElement) || !!window.getSelection()?.toString() || !!dragRef.current
    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      if (busy(e) || !selectedRef.current.size) return
      const clip = copyNow(cut)
      if (!clip) return
      e.clipboardData?.setData('text/plain', JSON.stringify(clip))
      e.preventDefault()
    }
    const copy = (e: ClipboardEvent): void => onCopy(e, false)
    const cut = (e: ClipboardEvent): void => onCopy(e, true)
    const paste = (e: ClipboardEvent): void => {
      if (busy(e)) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      // The system clipboard is the truth when it holds a piece of chart; when it holds
      // nothing readable, what this window copied last.
      const clip = readClip(text) ?? (!text && inAppClip ? inAppClip.clip : null)
      if (!clip) return
      e.preventDefault()
      pasteNow(clip, text || inAppClip?.text || '')
    }
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', paste)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', paste)
    }
  })

  /** From a menu: the system clipboard too, by asking the page to copy (which lands above). */
  const copyFromMenu = (cut: boolean): void => {
    let handled = false
    const mark = (): void => {
      handled = true
    }
    document.addEventListener(cut ? 'cut' : 'copy', mark, { once: true })
    try {
      document.execCommand(cut ? 'cut' : 'copy')
    } catch {
      // Not allowed here: the in-window copy below still works.
    }
    document.removeEventListener(cut ? 'cut' : 'copy', mark)
    if (!handled) copyNow(cut)
  }

  const start = (kind: 'tree' | 'boxes'): void => {
    const drawn = kind === 'tree' ? treeTemplate(cast) : boxesTemplate(cast)
    const l = layout(drawn)
    const view = viewFor(bounds(l))
    const tray = trayRef.current?.getBoundingClientRect()
    if (tray && !reduced) {
      // Everybody comes in from the list, a beat apart, as if dealt onto the board.
      let i = 0
      for (const n of drawn.nodes) {
        if (n.kind !== 'person') continue
        const from = toBoard(tray.left + 24, tray.top + 64 + Math.min(i, 10) * 40, view)
        spawn.current.set(n.id, { ...from, delay: 0.05 + i * 0.045 })
        i++
      }
    }
    moveView(view, true)
    commit(drawn)
  }

  const tidyUp = (): void => {
    const before = bounds(base)
    const next = tidy(displayRef.current)
    commit(next)
    const after = bounds(layout(sanitize(next, cast)))
    if (before && after) fit(true)
  }

  // Keys: undo and redo, select all, group, duplicate, take the selection off, let go
  // of everything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target)) return
      // A dialog over the board owns the keyboard.
      if (castModal || (e.target as HTMLElement | null)?.closest?.('[role="dialog"],[data-modal-backdrop]')) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key === 'a' && !dragRef.current) {
        e.preventDefault()
        select(displayRef.current.nodes.map((n) => n.id))
        return
      }
      if (mod && key === 'g' && selected.size && !dragRef.current) {
        e.preventDefault()
        group(selected)
        return
      }
      if (mod && key === 'd' && selected.size && !dragRef.current) {
        e.preventDefault()
        duplicate(selected)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size && !dragRef.current && !mod) {
        e.preventDefault()
        takeOff(selected)
        return
      }
      if (e.key === 'Escape') {
        if (dragRef.current) cancelDrag()
        else if (marqueeRef.current) endMarquee()
        else {
          select([])
          setEditingRole(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---------------------------------------------------------------- the background */

  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const marqueeCleanup = useRef<(() => void) | null>(null)
  const endMarquee = (): void => {
    marqueeCleanup.current?.()
    marqueeCleanup.current = null
    marqueeRef.current = null
    setMarquee(null)
  }

  /**
   * Shift, ⌘ or Ctrl held, a drag on open board draws a marquee and selects what it
   * covers — every card it touches, and every box it takes in whole (so a marquee
   * across part of a box picks the cards in it, not the box). It adds to what was
   * selected. It starts only on open board: a press on a box is a press on the box.
   */
  const startMarquee = (e: React.PointerEvent): void => {
    const rect = containerRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const m: Marquee = { sx0: sx, sy0: sy, sx1: sx, sy1: sy, before: new Set(selRef.current) }
    marqueeRef.current = m
    const board = displayRef.current
    const l = base
    const move = (ev: PointerEvent): void => {
      const cur = marqueeRef.current
      if (!cur) return
      cur.sx1 = ev.clientX - rect.left
      cur.sy1 = ev.clientY - rect.top
      if (Math.hypot(cur.sx1 - cur.sx0, cur.sy1 - cur.sy0) < DRAG_THRESHOLD) return
      const a = toBoard(cur.sx0 + rect.left, cur.sy0 + rect.top)
      const b = toBoard(cur.sx1 + rect.left, cur.sy1 + rect.top)
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }
      const hits = board.nodes
        .filter((n) => {
          const r = l.rects.get(n.id)
          if (!r) return false
          return n.kind === 'box'
            ? r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x2 && r.y + r.h <= box.y2
            : r.x < box.x2 && r.x + r.w > box.x && r.y < box.y2 && r.y + r.h > box.y
        })
        .map((n) => n.id)
      select([...cur.before, ...hits])
      setMarquee({ ...cur })
    }
    const up = (): void => endMarquee()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    marqueeCleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }

  const onSurfacePointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    const t = e.target as HTMLElement
    if (t.closest('[data-tray]') || t.closest('[data-toolbar]') || t.closest('[data-popover]') || t.closest('[data-start]')) return
    if (e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      startMarquee(e)
      return
    }
    panRef.current = { startClient: { x: e.clientX, y: e.clientY }, origin: { x: vx.get(), y: vy.get() }, moved: false }
    const move = (ev: PointerEvent): void => {
      const pan = panRef.current
      if (!pan) return
      const dx = ev.clientX - pan.startClient.x
      const dy = ev.clientY - pan.startClient.y
      if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      pan.moved = true
      vx.set(pan.origin.x + dx)
      vy.set(pan.origin.y + dy)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (panRef.current && !panRef.current.moved) {
        select([])
        setEditingRole(null)
        setRenaming(null)
      }
      panRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Remember where the pointer is on open board, for pasting there. */
  const onSurfacePointerMove = (e: React.PointerEvent): void => {
    const t = e.target as HTMLElement
    pointerAt.current =
      t.closest('[data-tray]') || t.closest('[data-toolbar]') || t.closest('[data-popover]') || t.closest('[data-start]')
        ? null
        : toBoard(e.clientX, e.clientY)
  }

  const boardMenu = (e: React.MouseEvent): void => {
    const t = e.target as HTMLElement
    if (t.closest('[data-tray]') || t.closest('[data-toolbar]') || t.closest('[data-node]')) return
    const at = toBoard(e.clientX, e.clientY)
    const items: MenuItem[] = [
      { label: 'Add a box here', icon: 'box', onSelect: () => addBox(at) },
      ...(inAppClip
        ? [{ label: 'Paste here', icon: 'paste' as IconName, shortcut: `${MOD}V`, onSelect: () => inAppClip && pasteNow(inAppClip.clip, inAppClip.text, at) }]
        : []),
      { label: 'Select all', icon: 'checkbox', shortcut: `${MOD}A`, onSelect: () => select(display.nodes.map((n) => n.id)), disabled: display.nodes.length === 0 },
      { label: 'Tidy up', icon: 'tidy', onSelect: tidyUp, disabled: display.nodes.length === 0 },
      { label: 'Show everything', icon: 'fit', onSelect: () => fit(true) }
    ]
    if (display.nodes.length) {
      items.push('separator', {
        label: 'Clear the board',
        icon: 'trash',
        danger: true,
        confirm: {
          title: 'Clear the whole chart?',
          body: `Everybody goes back to the list. ${MOD}Z brings it back.`,
          confirmLabel: 'Clear'
        },
        onSelect: () => commit(EMPTY_CHART)
      })
    }
    openMenu(e, items)
  }

  /** What can be done to whatever is selected, one thing or many. */
  const editItems = (ids: Set<string>, many: boolean): MenuItem[] => [
    { label: many ? 'Group into box' : 'Put in a new box', icon: 'group', shortcut: `${MOD}G`, onSelect: () => group(ids) },
    { label: 'Copy', icon: 'copy', shortcut: `${MOD}C`, onSelect: () => copyFromMenu(false) },
    { label: 'Cut', icon: 'scissors', shortcut: `${MOD}X`, onSelect: () => copyFromMenu(true) },
    { label: 'Duplicate', icon: 'plus', shortcut: `${MOD}D`, onSelect: () => duplicate(ids) }
  ]

  const nodeMenu = (e: React.MouseEvent, node: TeamNode): void => {
    e.stopPropagation()
    // Right-clicking one of several speaks for all of them.
    if (selected.has(node.id) && selected.size > 1) {
      const ids = new Set(selected)
      const loose = selectionRoots(display, ids).some((id) => {
        const n = display.nodes.find((x) => x.id === id)
        return n?.parentId || n?.boxId
      })
      openMenu(e, [
        ...editItems(ids, true),
        ...(loose ? [{ label: 'Stand on their own', icon: 'arrowLeft' as IconName, onSelect: () => standFree(ids) }] : []),
        'separator',
        { label: `Take ${ids.size} off the chart`, icon: 'close', shortcut: '⌫', onSelect: () => takeOff(ids) }
      ])
      return
    }
    select([node.id])
    const ids = new Set([node.id])
    const member = node.personId ? members.get(node.personId) : undefined
    const loose = node.parentId || node.boxId
      ? [{ label: 'Stand on its own', icon: 'arrowLeft' as IconName, onSelect: () => standFree(ids) }]
      : []
    const items: MenuItem[] =
      node.kind === 'person' && member
        ? [
            { label: 'Change role', icon: 'edit', onSelect: () => setEditingRole(node.id) },
            ...loose,
            ...editItems(ids, false),
            { label: 'Take off the chart', icon: 'close', shortcut: '⌫', onSelect: () => takeOff(ids) },
            'separator',
            ...memberItems(member)
          ]
        : [
            { label: 'Rename', icon: 'edit', onSelect: () => setRenaming(node.id) },
            ...loose,
            ...editItems(ids, false),
            'separator',
            { label: 'Remove the box', icon: 'trash', danger: true, shortcut: '⌫', onSelect: () => takeOff(ids) }
          ]
    openMenu(e, items)
  }

  /* ---------------------------------------------------------------- drawing it */

  const targetId = drag?.started && drag.target && (drag.target.kind === 'parent' || drag.target.kind === 'box') ? drag.target.id : null
  const heldList = drag?.started ? (drag.fresh ? [drag.fresh.id] : drag.target?.kind === 'box' ? drag.joiners : drag.roots) : []
  // The one in your hand is named first; the rest are counted.
  const named = moverId && heldList.includes(moverId) ? moverId : heldList[0]
  const moverName = heldList.length ? (drag?.member?.name ?? nameOf(named)) : ''
  const who = heldList.length > 1 ? `${moverName} and ${heldList.length - 1} more` : moverName
  const carriedMore = movingIds ? movingIds.size - 1 : 0
  let caption = ''
  if (drag?.started) {
    if (!drag.target) caption = `Let go to put ${who} back`
    else if (drag.target.kind === 'remove' && carriedMore > 0) caption = `Take ${moverName} and ${carriedMore} more off the chart`
    else caption = describeDrop(drag.target, who, (id) => nameOf(id), heldList.length > 1)
  }

  const layerNodes = (top: boolean): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    // Outer boxes under inner ones, every box under the cards.
    const rank = (id: string): number => (nodeById.get(id)?.kind === 'box' ? (depthOf.get(id) ?? 0) : 1000)
    const ordered = [...rects.keys()].sort((a, b) => rank(a) - rank(b))
    for (const id of ordered) {
      if (!!movingIds?.has(id) !== top) continue
      const node = nodeById.get(id)
      if (!node) continue
      const m = motionFor(id, rects.get(id)!)
      const lifted = top && !!liftedIds?.has(id)
      // Only a single thing tilts as it is swung about: a group, or a box with cards in
      // it, is several pieces that would each tilt about their own middle.
      const tilt = lifted && movingIds?.size === 1 ? (drag?.tilt ?? 0) : 0
      const member = node.personId ? members.get(node.personId) : undefined
      if (node.kind === 'person' && !member) continue
      const pop = popIn.current.get(id)
      out.push(
        <motion.div
          key={id}
          data-node
          className={`absolute left-0 top-0 ${lifted ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ x: m.x, y: m.y, width: m.w, height: m.h, zIndex: rank(id) }}
          onPointerDown={(e) => onNodePointerDown(e, id)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (member) navigate(`/people/${member.personId}`)
            else setRenaming(id)
          }}
          onContextMenu={(e) => nodeMenu(e, node)}
        >
          <motion.div
            className="h-full w-full"
            initial={
              pop !== undefined
                ? { opacity: 0, scale: 0.82 }
                : reduced || spawn.current.has(id) || node.kind === 'person'
                  ? false
                  : { opacity: 0, scale: 0.92 }
            }
            animate={{
              opacity: 1,
              scale: lifted && !reduced ? (movingIds && movingIds.size > 1 ? 1.02 : 1.045) : targetId === id && node.kind === 'person' && !reduced ? 1.03 : 1,
              rotate: tilt
            }}
            transition={
              reduced
                ? STILL
                : pop !== undefined
                  ? { type: 'spring', stiffness: 520, damping: 22, delay: pop }
                  : { type: 'spring', stiffness: 500, damping: lifted ? 30 : 17 }
            }
          >
            {node.kind === 'person' && member ? (
              <PersonCard
                member={member}
                open={openCounts.get(member.personId) ?? 0}
                selected={selected.has(id) && !drag?.started}
                targeted={targetId === id}
                lifted={lifted}
                onEditRole={() => {
                  select([id])
                  setEditingRole(id)
                }}
              />
            ) : (
              <BoxCard
                label={node.label ?? ''}
                count={peopleIn.get(id) ?? 0}
                empty={!hasContents.has(id)}
                depth={depthOf.get(id) ?? 0}
                selected={selected.has(id) && !drag?.started}
                targeted={targetId === id}
                lifted={lifted}
                editing={renaming === id}
                onStartRename={() => setRenaming(id)}
                onRename={(label) => {
                  setRenaming(null)
                  if (label !== node.label) {
                    commit({
                      version: 1,
                      nodes: displayRef.current.nodes.map((n) => (n.id === id ? { ...n, label } : n))
                    })
                  }
                }}
              />
            )}
          </motion.div>
        </motion.div>
      )
    }
    return out
  }

  const layerEdges = (top: boolean): React.JSX.Element => (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
      {edges.map((e) => {
        const both = !!movingIds?.has(e.from) && !!movingIds?.has(e.to)
        if (both !== top) return null
        const from = motions.current.get(e.from)
        const to = motions.current.get(e.to)
        if (!from || !to || !rects.has(e.from) || !rects.has(e.to)) return null
        return (
          <Connector
            key={`${e.from}>${e.to}`}
            from={from}
            to={to}
            pending={!!moverId && e.to === moverId && drag?.target?.kind === 'parent'}
            reduced={reduced}
          />
        )
      })}
    </svg>
  )

  const world = { x: vx, y: vy, scale: vz, transformOrigin: '0 0' }
  const roleNode = editingRole ? display.nodes.find((n) => n.id === editingRole) : undefined
  const roleMember = roleNode?.personId ? members.get(roleNode.personId) : undefined
  const roleRect = editingRole ? base.rects.get(editingRole) : undefined
  const empty = loaded && display.nodes.length === 0 && !drag?.started

  return (
    <div
      ref={containerRef}
      className={`hairline relative h-[calc(100vh-212px)] min-h-[480px] touch-none select-none overflow-hidden rounded-box border bg-base-100 ${
        drag?.started ? 'cursor-grabbing' : ''
      }`}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerLeave={() => {
        pointerAt.current = null
      }}
      onContextMenu={boardMenu}
    >
      {/* The dot grid, panned and zoomed with the board so it reads as the surface. */}
      <motion.div
        className="pointer-events-none absolute inset-0 text-base-content"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in oklch, currentColor 13%, transparent) 1.1px, transparent 1.3px)',
          backgroundSize,
          backgroundPosition
        }}
      />

      <motion.div className="absolute left-0 top-0" style={world}>
        {layerEdges(false)}
        {layerNodes(false)}
        {bursts.map((b) => (
          <Burst key={b.id} x={b.x} y={b.y} tone={b.tone} />
        ))}
      </motion.div>

      {marquee && (
        <div
          className="pointer-events-none absolute z-10 rounded-[6px] border border-primary/50 bg-primary/[0.06]"
          style={{
            left: Math.min(marquee.sx0, marquee.sx1),
            top: Math.min(marquee.sy0, marquee.sy1),
            width: Math.abs(marquee.sx1 - marquee.sx0),
            height: Math.abs(marquee.sy1 - marquee.sy0)
          }}
        />
      )}

      <div data-toolbar className="absolute left-3 top-3 z-20 flex items-center gap-1">
        <div className="glass-raised hairline flex items-center gap-0.5 rounded-field border bg-base-100/95 p-1 shadow-[0_8px_24px_-16px_rgb(0_0_0/0.35)] backdrop-blur">
          <ToolButton icon="plus" label="Add person" onClick={() => setCastModal({ member: null })} />
          <ToolButton icon="box" label="Add box" onClick={() => addBox()} />
          <ToolButton icon="tidy" label="Tidy" onClick={tidyUp} disabled={display.nodes.length === 0} />
          <Divider />
          <ToolButton icon="undo" title={`Undo (${MOD}Z)`} onClick={undo} disabled={past.current.length === 0} />
          <ToolButton icon="redo" title={`Redo (⇧${MOD}Z)`} onClick={redo} disabled={future.current.length === 0} />
          <Divider />
          <ToolButton icon="minus" title="Zoom out" onClick={() => zoomBy(1 / 1.25)} />
          <motion.span className="w-11 text-center text-[11px] tabular-nums text-base-content/50">{zoomLabel}</motion.span>
          <ToolButton icon="plus" title="Zoom in" onClick={() => zoomBy(1.25)} />
          <ToolButton icon="fit" title="Show everything" onClick={() => fit(true)} />
        </div>
        <span className="ml-2 text-[11px] text-base-content/40" aria-live="polite">
          {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved — check the connection' : saveState === 'saved' ? 'Saved' : ''}
        </span>
      </div>

      {empty && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center justify-center"
          style={{ right: TRAY_SPACE }}
        >
          <div data-start className="pointer-events-auto">
            <StartChoices
              people={cast.length}
              onTree={() => start('tree')}
              onBoxes={() => start('boxes')}
              onAddPeople={() => setCastModal({ member: null })}
            />
          </div>
        </div>
      )}

      <Tray
        cast={cast}
        placed={placed}
        dragging={!!drag?.started}
        removing={!!drag?.started && drag.target?.kind === 'remove'}
        trayRef={trayRef}
        onPick={onTrayPick}
        onClickPerson={onTrayClick}
        onAddPeople={() => setCastModal({ member: null })}
        onMenu={(e, member) => openMenu(e, memberItems(member))}
      />

      {/* What is in your hand, above the list so it can be dragged back onto it. */}
      <motion.div className="pointer-events-none absolute left-0 top-0 z-30" style={world}>
        {layerEdges(true)}
        {layerNodes(true)}
      </motion.div>

      {/* Says what letting go would do, while it is still undecided. */}
      <div className="pointer-events-none absolute bottom-4 left-0 z-30 flex justify-center" style={{ right: TRAY_SPACE }}>
        {caption ? (
          <motion.div
            key={caption}
            className={`glass-raised rounded-full border px-3.5 py-1.5 text-[12px] font-medium shadow-[0_10px_30px_-14px_rgb(0_0_0/0.4)] ${
              drag?.target?.kind === 'remove'
                ? 'border-error/40 bg-base-100 text-error'
                : drag?.target && drag.target.kind !== 'free'
                  ? 'border-primary/40 bg-base-100 text-primary'
                  : 'hairline bg-base-100 text-base-content/70'
            }`}
            initial={reduced ? false : { opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.16, ease: EASE }}
          >
            {caption}
          </motion.div>
        ) : (
          !empty &&
          display.nodes.length > 0 && (
            <div className="text-[11px] text-base-content/35">
              {selected.size > 1 ? (
                <>
                  <span className="font-medium text-primary/80 tabular-nums">{selected.size} selected</span>
                  {` · drag to move together · ${MOD}G groups into a box · ${MOD}C copies · ⌫ takes them off`}
                </>
              ) : selected.size === 1 ? (
                `Drag to move · ⇧-click to select more · ⌫ takes it off the chart · double-click to open`
              ) : (
                'Drop someone on a card to report to it · into a box to group · drag the board to pan · ⇧-drag to select'
              )}
            </div>
          )
        )}
      </div>

      {roleNode && roleMember && roleRect && (
        <RolePopover
          member={roleMember}
          at={(() => {
            // Under the card, unless that runs off the bottom — then above it — and
            // never under the list of people.
            const box = containerRef.current?.getBoundingClientRect()
            const width = box?.width ?? 900
            const height = box?.height ?? 600
            const below = (roleRect.y + roleRect.h) * vz.get() + vy.get() + 8
            const above = roleRect.y * vz.get() + vy.get() - 8
            return {
              x: Math.max(12, Math.min(roleRect.x * vz.get() + vx.get(), width - TRAY_SPACE - 292)),
              y: below + 260 > height && above > 260 ? above : below,
              up: below + 260 > height && above > 260
            }
          })()}
          suggestions={roleSuggestions.data ?? []}
          onChange={(roles) => saveMembership.mutate({ id: roleMember.id, role: formatRoles(roles) })}
          onClose={() => setEditingRole(null)}
          onOpen={() => navigate(`/people/${roleMember.personId}`)}
        />
      )}

      <CastMemberModal
        open={castModal !== null}
        onClose={() => setCastModal(null)}
        member={castModal?.member ?? null}
        projectId={project.id}
        existing={cast.map((c) => c.personId)}
      />
    </div>
  )
}

function RolePopover({
  member,
  at,
  suggestions,
  onChange,
  onClose,
  onOpen
}: {
  member: CastMember
  at: { x: number; y: number; up: boolean }
  suggestions: string[]
  onChange: (roles: string[]) => void
  onClose: () => void
  onOpen: () => void
}): React.JSX.Element {
  const [roles, setRoles] = useState(() => parseRoles(member.role))
  return (
    <div
      data-popover
      className="absolute z-40"
      style={{ left: at.x, top: at.y, transform: at.up ? 'translateY(-100%)' : undefined }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
    <motion.div
      className="glass-raised hairline w-[280px] rounded-box border bg-base-100 p-3 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.45)]"
      initial={{ opacity: 0, y: at.up ? 4 : -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.14, ease: EASE }}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[12px] font-semibold">{member.name} on this project</span>
        <button className="text-[11px] text-base-content/45 transition hover:text-primary" onClick={onOpen}>
          Open
        </button>
      </div>
      <RoleInput
        roles={roles}
        suggestions={suggestions}
        autoFocus
        onChange={(next) => {
          setRoles(next)
          onChange(next)
        }}
      />
      <div className="mt-2 flex justify-end">
        <button className="btn btn-ghost btn-xs" onClick={onClose}>
          Done
        </button>
      </div>
    </motion.div>
    </div>
  )
}

function ToolButton({
  icon,
  label,
  title,
  onClick,
  disabled
}: {
  icon: IconName
  label?: string
  title?: string
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      className={`flex h-7 items-center gap-1.5 rounded-[7px] text-[12px] text-base-content/70 transition hover:bg-base-content/[0.07] hover:text-base-content disabled:opacity-30 disabled:hover:bg-transparent ${
        label ? 'px-2' : 'w-7 justify-center'
      }`}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  )
}

function Divider(): React.JSX.Element {
  return <span className="mx-0.5 h-4 w-px bg-base-content/10" />
}
