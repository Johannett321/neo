import type { CastMember, TeamChart, TeamNode } from '@shared/types'
import { parseRoles } from '@/components/RoleInput'

/*
 * The team board's pure half: what the drawing means, where everything goes, and what
 * each gesture does to it. Nothing here touches React or the screen, so the view only
 * ever asks two questions — "where is everything?" (`layout`) and "what happens if I
 * let go here?" (`applyDrop`) — and the answer to the second is drawn as a preview
 * before it is committed. That is what lets the cards part to make room while you are
 * still holding one.
 *
 * Two relations make the picture. `parentId` is *reports to*, drawn as a tree with
 * lines, and `boxId` is *sits in*, a grid inside a labelled box. Only nodes that are
 * neither keep their own position; everything else is placed by the layout, which is
 * why the tree stays tidy however it was built.
 */

export const CARD_W = 224
export const CARD_H = 64
/** Between two subtrees side by side. */
export const H_GAP = 28
/** Between a card and the row of cards under it. */
export const V_GAP = 64
export const BOX_PAD = 14
export const BOX_HEADER = 38
export const BOX_GAP = 10
export const GRID = 24

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  rects: Map<string, Rect>
  /** Parent → child, both node ids. */
  edges: { from: string; to: string }[]
  /** Each box's member ids in order, and its column count. */
  boxes: Map<string, { members: string[]; cols: number }>
}

export const EMPTY_CHART: TeamChart = { version: 1, nodes: [] }

export const snap = (v: number): number => Math.round(v / GRID) * GRID

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

const byOrder = (a: TeamNode, b: TeamNode): number => (a.order ?? 0) - (b.order ?? 0)

/**
 * The drawing as it can be drawn today: cards for people still on the project, links
 * only to nodes that exist, a person in a box never also hanging under something, and
 * no loops. A chart is written by a client and read by a client, so it is repaired on
 * the way in rather than trusted.
 */
export function sanitize(chart: TeamChart, cast: CastMember[]): TeamChart {
  const people = new Set(cast.map((c) => c.personId))
  let nodes = (chart.nodes ?? []).filter((n) => (n.kind === 'person' ? !!n.personId && people.has(n.personId) : n.kind === 'box'))
  const ids = new Map(nodes.map((n) => [n.id, n]))
  nodes = nodes.map((n) => {
    let { parentId, boxId } = n
    if (boxId && (n.kind !== 'person' || ids.get(boxId)?.kind !== 'box')) boxId = null
    if (boxId) parentId = null
    if (parentId && !ids.has(parentId)) parentId = null
    return parentId === n.parentId && boxId === n.boxId ? n : { ...n, parentId: parentId ?? null, boxId: boxId ?? null }
  })
  // Nothing may hang under a card that sits in a box: what reports to a box member
  // reports to the box.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  nodes = nodes.map((n) => {
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    return parent?.boxId ? { ...n, parentId: parent.boxId } : n
  })
  // Break any loop at the node where it is found.
  const final = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    let cur = n.parentId ? final.get(n.parentId) : undefined
    while (cur) {
      if (seen.has(cur.id)) {
        final.set(n.id, { ...n, parentId: null })
        break
      }
      seen.add(cur.id)
      cur = cur.parentId ? final.get(cur.parentId) : undefined
    }
  }
  return { version: 1, nodes: [...final.values()] }
}

export function boxCols(n: number): number {
  if (n <= 1) return 1
  if (n <= 3) return n
  return Math.min(4, Math.ceil(Math.sqrt(n)))
}

function boxSize(members: number): { w: number; h: number } {
  const cols = boxCols(Math.max(members, 1))
  const rows = Math.max(1, Math.ceil(members / cols))
  return {
    w: BOX_PAD * 2 + cols * CARD_W + (cols - 1) * BOX_GAP,
    h: BOX_HEADER + BOX_PAD + rows * CARD_H + (rows - 1) * BOX_GAP
  }
}

/** Where everything goes. */
export function layout(chart: TeamChart): Layout {
  const nodes = chart.nodes
  const rects = new Map<string, Rect>()
  const edges: Layout['edges'] = []
  const boxes: Layout['boxes'] = new Map()

  const members = new Map<string, TeamNode[]>()
  const children = new Map<string, TeamNode[]>()
  for (const n of nodes) {
    if (n.boxId) (members.get(n.boxId) ?? members.set(n.boxId, []).get(n.boxId)!).push(n)
    else if (n.parentId) (children.get(n.parentId) ?? children.set(n.parentId, []).get(n.parentId)!).push(n)
  }
  members.forEach((list) => list.sort(byOrder))
  children.forEach((list) => list.sort(byOrder))

  const size = (n: TeamNode): { w: number; h: number } =>
    n.kind === 'box' ? boxSize(members.get(n.id)?.length ?? 0) : { w: CARD_W, h: CARD_H }

  const widths = new Map<string, number>()
  const subtreeWidth = (n: TeamNode, depth = 0): number => {
    if (depth > 64) return size(n).w
    const kids = children.get(n.id) ?? []
    const row = kids.reduce((sum, k) => sum + subtreeWidth(k, depth + 1), 0) + Math.max(0, kids.length - 1) * H_GAP
    const w = Math.max(size(n).w, row)
    widths.set(n.id, w)
    return w
  }

  const place = (n: TeamNode, centreX: number, top: number, depth = 0): void => {
    const s = size(n)
    rects.set(n.id, { x: centreX - s.w / 2, y: top, w: s.w, h: s.h })
    if (n.kind === 'box') {
      const list = members.get(n.id) ?? []
      const cols = boxCols(Math.max(list.length, 1))
      boxes.set(n.id, { members: list.map((m) => m.id), cols })
      list.forEach((m, i) => {
        rects.set(m.id, {
          x: centreX - s.w / 2 + BOX_PAD + (i % cols) * (CARD_W + BOX_GAP),
          y: top + BOX_HEADER + Math.floor(i / cols) * (CARD_H + BOX_GAP),
          w: CARD_W,
          h: CARD_H
        })
      })
    }
    if (depth > 64) return
    const kids = children.get(n.id) ?? []
    if (!kids.length) return
    const total = kids.reduce((sum, k) => sum + (widths.get(k.id) ?? CARD_W), 0) + (kids.length - 1) * H_GAP
    let left = centreX - total / 2
    for (const k of kids) {
      const w = widths.get(k.id) ?? CARD_W
      place(k, left + w / 2, top + s.h + V_GAP, depth + 1)
      edges.push({ from: n.id, to: k.id })
      left += w + H_GAP
    }
  }

  for (const root of roots(chart)) {
    subtreeWidth(root)
    place(root, root.x + size(root).w / 2, root.y)
  }
  return { rects, edges, boxes }
}

/** Nodes that keep their own position: neither under anything nor in a box. */
export const roots = (chart: TeamChart): TeamNode[] => chart.nodes.filter((n) => !n.parentId && !n.boxId)

/** A node and everything that moves with it: what hangs under it, and what sits in it. */
export function carried(chart: TeamChart, id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const n of chart.nodes) {
      if (out.has(n.id)) continue
      if ((n.parentId && out.has(n.parentId)) || (n.boxId && out.has(n.boxId))) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

/** The bounding box of everything drawn, or null for an empty board. */
export function bounds(l: Layout): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  l.rects.forEach((r) => {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  })
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/* ------------------------------------------------------------------ gestures */

export type DropTarget =
  | { kind: 'parent'; id: string; index: number }
  | { kind: 'box'; id: string; index: number }
  | { kind: 'free'; x: number; y: number }
  | { kind: 'remove' }

/** Put `ids` in order and number them, so a position means something among neighbours. */
function renumber(nodes: TeamNode[], ids: string[]): TeamNode[] {
  const at = new Map(ids.map((id, i) => [id, i]))
  return nodes.map((n) => (at.has(n.id) ? { ...n, order: at.get(n.id)! } : n))
}

function siblingsOf(nodes: TeamNode[], target: DropTarget, except: string): string[] {
  return nodes
    .filter((n) => n.id !== except && (target.kind === 'box' ? n.boxId === target.id : target.kind === 'parent' && !n.boxId && n.parentId === target.id))
    .sort(byOrder)
    .map((n) => n.id)
}

/**
 * Take a node off the board. What hung under it moves up to whatever it hung under,
 * and what sat in a box steps out where it stood — nothing else on the board moves
 * because one card left.
 */
export function remove(chart: TeamChart, id: string, current: Layout): TeamChart {
  const gone = chart.nodes.find((n) => n.id === id)
  if (!gone) return chart
  const inherit = gone.parentId ?? gone.boxId ?? null
  const nodes = chart.nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      if (n.parentId !== id && n.boxId !== id) return n
      if (n.boxId === id) {
        // A box's members step out: under the box's own parent if it had one, else
        // as loose cards exactly where they were standing.
        if (gone.parentId) return { ...n, boxId: null, parentId: gone.parentId }
        const r = current.rects.get(n.id)
        return { ...n, boxId: null, parentId: null, x: snap(r?.x ?? n.x), y: snap(r?.y ?? n.y) }
      }
      if (inherit && gone.boxId) return { ...n, parentId: gone.boxId }
      if (inherit) return { ...n, parentId: inherit }
      const r = current.rects.get(n.id)
      return { ...n, parentId: null, x: snap(r?.x ?? n.x), y: snap(r?.y ?? n.y) }
    })
  return { version: 1, nodes }
}

/**
 * What the board would be if `node` were let go at `target`. `node` may be new (from
 * the tray) or already on the board.
 */
export function applyDrop(chart: TeamChart, node: TeamNode, target: DropTarget): TeamChart {
  // What you are holding is what goes: a card dragged off the board takes whatever
  // hung under it and whatever sat in it, exactly as it was carried there.
  if (target.kind === 'remove') {
    const gone = carried(chart, node.id)
    return { version: 1, nodes: chart.nodes.filter((n) => !gone.has(n.id)) }
  }

  const exists = chart.nodes.some((n) => n.id === node.id)
  let nodes = exists ? chart.nodes : [...chart.nodes, node]

  if (target.kind === 'free') {
    nodes = nodes.map((n) => (n.id === node.id ? { ...n, parentId: null, boxId: null, x: target.x, y: target.y } : n))
    return { version: 1, nodes }
  }

  if (target.kind === 'box') {
    if (node.kind !== 'person') return chart
    nodes = nodes.map((n) => {
      if (n.id === node.id) return { ...n, boxId: target.id, parentId: null }
      // What reported to this person now reports to the box they joined.
      if (n.parentId === node.id) return { ...n, parentId: target.id }
      return n
    })
  } else {
    nodes = nodes.map((n) => (n.id === node.id ? { ...n, parentId: target.id, boxId: null } : n))
  }

  const order = siblingsOf(nodes, target, node.id)
  order.splice(Math.max(0, Math.min(target.index, order.length)), 0, node.id)
  return { version: 1, nodes: renumber(nodes, order) }
}

/** The sentence for what letting go would do, said while it is still undecided. */
export function describeDrop(
  target: DropTarget | null,
  who: string,
  nameOf: (nodeId: string) => string
): string {
  if (!target) return ''
  switch (target.kind) {
    case 'parent':
      return `${who} reports to ${nameOf(target.id)}`
    case 'box':
      return `${who} joins ${nameOf(target.id)}`
    case 'free':
      return `Place ${who} here`
    case 'remove':
      return `Take ${who} off the chart`
  }
}

/**
 * Lay the free-standing trees out in a row, left to right in the order they already
 * are, so none of them overlaps another. Everything under them follows by itself.
 */
export function tidy(chart: TeamChart, maxRow = 1600): TeamChart {
  const l = layout(chart)
  const tops = roots(chart).sort((a, b) => a.x - b.x || a.y - b.y)
  const extent = (id: string): Rect => {
    let r = { ...l.rects.get(id)! }
    for (const c of carried(chart, id)) {
      const cr = l.rects.get(c)
      if (!cr) continue
      const x = Math.min(r.x, cr.x)
      const y = Math.min(r.y, cr.y)
      r = { x, y, w: Math.max(r.x + r.w, cr.x + cr.w) - x, h: Math.max(r.y + r.h, cr.y + cr.h) - y }
    }
    return r
  }
  const start = tops.length ? snap(Math.min(...tops.map((t) => extent(t.id).x))) : 0
  let left = start
  let top = tops.length ? snap(Math.min(...tops.map((t) => t.y))) : 0
  let rowBottom = top
  const moved = new Map<string, { x: number; y: number }>()
  for (const t of tops) {
    const e = extent(t.id)
    const own = l.rects.get(t.id)!
    // Wrap rather than run off to the right: a board you have to scroll sideways
    // through is not a picture of anything.
    if (left > start && left - start + e.w > maxRow) {
      left = start
      top = snap(rowBottom + V_GAP)
    }
    moved.set(t.id, { x: snap(left + (own.x - e.x)), y: top })
    rowBottom = Math.max(rowBottom, top + e.h)
    left += e.w + H_GAP * 3
  }
  return { version: 1, nodes: chart.nodes.map((n) => (moved.has(n.id) ? { ...n, ...moved.get(n.id)! } : n)) }
}

/* ------------------------------------------------------------------ starting points */

const LEAD = /\b(lead|owner|manager|head|director|chief|ceo|cto|cpo|founder|sponsor|pm|project manager|product manager|approver)\b/i

const firstRole = (m: CastMember): string => parseRoles(m.role)[0] ?? ''

/** Whoever reads as the one in charge: a lead-sounding role first, then you, then the first. */
export function pickLead(cast: CastMember[]): CastMember | undefined {
  return cast.find((m) => parseRoles(m.role).some((r) => LEAD.test(r))) ?? cast.find((m) => m.isMe) ?? cast[0]
}

/** People sharing a first role, in the order the role first appears; the role-less last. */
function byRole(cast: CastMember[]): { role: string; people: CastMember[] }[] {
  const groups = new Map<string, { role: string; people: CastMember[] }>()
  for (const m of cast) {
    const role = firstRole(m)
    const key = role.toLowerCase()
    if (!groups.has(key)) groups.set(key, { role, people: [] })
    groups.get(key)!.people.push(m)
  }
  const list = [...groups.values()]
  return [...list.filter((g) => g.role), ...list.filter((g) => !g.role)]
}

/**
 * A tree: the lead at the top and everyone else under them. Where two or more share a
 * role they are boxed together under it, so a team of twelve is not a row of twelve.
 */
export function treeTemplate(cast: CastMember[]): TeamChart {
  const lead = pickLead(cast)
  if (!lead) return EMPTY_CHART
  const top: TeamNode = { id: uid(), kind: 'person', personId: lead.personId, x: 0, y: 0 }
  const nodes: TeamNode[] = [top]
  let order = 0
  for (const group of byRole(cast.filter((m) => m.id !== lead.id))) {
    if (group.people.length >= 2 && group.role) {
      const box: TeamNode = { id: uid(), kind: 'box', label: group.role, x: 0, y: 0, parentId: top.id, order: order++ }
      nodes.push(box)
      group.people.forEach((m, i) =>
        nodes.push({ id: uid(), kind: 'person', personId: m.personId, x: 0, y: 0, boxId: box.id, order: i }))
    } else {
      for (const m of group.people) {
        nodes.push({ id: uid(), kind: 'person', personId: m.personId, x: 0, y: 0, parentId: top.id, order: order++ })
      }
    }
  }
  return { version: 1, nodes }
}

/** Boxes: one per role, everyone in the box of the first role they hold. */
export function boxesTemplate(cast: CastMember[]): TeamChart {
  const nodes: TeamNode[] = []
  for (const group of byRole(cast)) {
    const box: TeamNode = { id: uid(), kind: 'box', label: group.role || 'No role yet', x: 0, y: 0 }
    nodes.push(box)
    group.people.forEach((m, i) =>
      nodes.push({ id: uid(), kind: 'person', personId: m.personId, x: 0, y: 0, boxId: box.id, order: i }))
  }
  // Order the boxes left to right as the groups came, then tidy so none overlap.
  let x = 0
  const placed = nodes.map((n) => {
    if (n.kind !== 'box') return n
    const out = { ...n, x }
    x += 1000
    return out
  })
  return tidy({ version: 1, nodes: placed })
}

/** The free-standing node a node ultimately hangs from or sits in. */
export function rootOf(chart: TeamChart, id: string): string {
  const byId = new Map(chart.nodes.map((n) => [n.id, n]))
  let cur = byId.get(id)
  for (let i = 0; cur && i < 128; i++) {
    const up = cur.boxId ?? cur.parentId
    if (!up || !byId.has(up)) return cur.id
    cur = byId.get(up)
  }
  return id
}

/**
 * Make room. A tree that grows into the space another one stands in pushes that one
 * down out of its way, rather than the two being drawn through each other — the tree
 * you just changed stays exactly where you put it.
 */
export function separate(chart: TeamChart, keepId: string | null): TeamChart {
  const l = layout(chart)
  const tops = roots(chart)
  if (tops.length < 2) return chart
  const extent = new Map<string, Rect>()
  for (const t of tops) {
    let r: Rect | null = null
    for (const id of carried(chart, t.id)) {
      const cr = l.rects.get(id)
      if (!cr) continue
      if (!r) r = { ...cr }
      else {
        const x = Math.min(r.x, cr.x)
        const y = Math.min(r.y, cr.y)
        r = { x, y, w: Math.max(r.x + r.w, cr.x + cr.w) - x, h: Math.max(r.y + r.h, cr.y + cr.h) - y }
      }
    }
    if (r) extent.set(t.id, r)
  }
  const keep = keepId ? rootOf(chart, keepId) : null
  const order = [...tops].sort((a, b) =>
    a.id === keep ? -1 : b.id === keep ? 1 : extent.get(a.id)!.y - extent.get(b.id)!.y || extent.get(a.id)!.x - extent.get(b.id)!.x)
  const margin = 24
  const placed: Rect[] = []
  const moved = new Map<string, number>()
  for (const t of order) {
    const e = extent.get(t.id)
    if (!e) continue
    let dy = 0
    for (let guard = 0; guard < 50; guard++) {
      const hit = placed.find((p) =>
        e.x < p.x + p.w + margin && e.x + e.w + margin > p.x && e.y + dy < p.y + p.h + margin && e.y + dy + e.h + margin > p.y)
      if (!hit) break
      dy = hit.y + hit.h + margin * 2 - e.y
    }
    if (dy) moved.set(t.id, snap(dy + 12))
    placed.push({ ...e, y: e.y + (moved.get(t.id) ?? 0) })
  }
  if (!moved.size) return chart
  return { version: 1, nodes: chart.nodes.map((n) => (moved.has(n.id) ? { ...n, y: n.y + moved.get(n.id)! } : n)) }
}
