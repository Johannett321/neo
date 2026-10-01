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
 * only to nodes that exist, nothing both sitting in a box and hanging under something,
 * and no loops of either kind. A chart is written by a client and read by a client, so
 * it is repaired on the way in rather than trusted. Every step is deterministic — it
 * walks the nodes in the order the document lists them — so every client repairs a
 * broken chart the same way and draws the same picture.
 */
export function sanitize(chart: TeamChart, cast: CastMember[]): TeamChart {
  const people = new Set(cast.map((c) => c.personId))
  // 1. Who can be drawn: a person still on the project, or a box. A repeated id keeps
  //    its first node.
  const seen = new Set<string>()
  let nodes = (chart.nodes ?? []).filter((n) => {
    if (!n || typeof n.id !== 'string' || seen.has(n.id)) return false
    const keep = n.kind === 'person' ? !!n.personId && people.has(n.personId) : n.kind === 'box'
    if (keep) seen.add(n.id)
    return keep
  })
  // 2. Links only to what is there: `boxId` names a box (any node may sit in one, a box
  //    included, never itself), `parentId` names any node, and sitting
  //    in a box wins over hanging under something.
  const ids = new Map(nodes.map((n) => [n.id, n]))
  nodes = nodes.map((n) => {
    let { parentId, boxId } = n
    if (boxId && (boxId === n.id || ids.get(boxId)?.kind !== 'box')) boxId = null
    if (boxId) parentId = null
    if (parentId && !ids.has(parentId)) parentId = null
    return parentId === n.parentId && boxId === n.boxId ? n : { ...n, parentId: parentId ?? null, boxId: boxId ?? null }
  })
  // 3. No box inside itself: the first node, in document order, that a chain of boxes
  //    leads back to steps out of its box.
  const inBox = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const start = inBox.get(n.id)!
    let cur = start.boxId ?? null
    for (let steps = 0; cur && cur !== n.id && steps <= nodes.length; steps++) cur = inBox.get(cur)?.boxId ?? null
    if (cur === n.id) inBox.set(n.id, { ...start, boxId: null })
  }
  nodes = nodes.map((n) => inBox.get(n.id)!)
  // 4. Nothing hangs under something that sits in a box: what reports to anything in a
  //    box reports to the outermost box around it, which is the one in the tree.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  nodes = nodes.map((n) => {
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    return parent?.boxId ? { ...n, parentId: outermost(byId, parent.id) } : n
  })
  // 5. No reporting loops: walking up from a node that finds a loop cuts that node free.
  const final = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const loopSeen = new Set<string>([n.id])
    let cur = n.parentId ? final.get(n.parentId) : undefined
    while (cur) {
      if (loopSeen.has(cur.id)) {
        final.set(n.id, { ...n, parentId: null })
        break
      }
      loopSeen.add(cur.id)
      cur = cur.parentId ? final.get(cur.parentId) : undefined
    }
  }
  return { version: 1, nodes: [...final.values()] }
}

/** The box a node is in, the box that one is in, and so on to the top: the last one. */
function outermost(byId: Map<string, TeamNode>, id: string): string {
  let cur = byId.get(id)
  for (let i = 0; cur?.boxId && i < 256; i++) {
    const up = byId.get(cur.boxId)
    if (!up) break
    cur = up
  }
  return cur?.id ?? id
}

/** The outermost box `id` sits in (through any number of boxes), or `id` when it is in none. */
export function topBox(chart: TeamChart, id: string): string {
  return outermost(new Map(chart.nodes.map((n) => [n.id, n])), id)
}

/** How many boxes deep a node sits: 0 for anything not in a box. */
export function depthOf(chart: TeamChart, id: string): number {
  const byId = new Map(chart.nodes.map((n) => [n.id, n]))
  let depth = 0
  let cur = byId.get(id)
  while (cur?.boxId && depth < 256) {
    depth++
    cur = byId.get(cur.boxId)
  }
  return depth
}

export function boxCols(n: number): number {
  if (n <= 1) return 1
  if (n <= 3) return n
  return Math.min(4, Math.ceil(Math.sqrt(n)))
}

/**
 * Where everything goes.
 *
 * A box lays out what sits in it — people and boxes alike, by `order` — as a table of
 * `boxCols(n)` columns filled row by row: each column as wide as its widest item, each
 * row as tall as its tallest, every item at the top-left of its cell. With nothing but
 * cards in it that is exactly the grid a box always was; a box inside is sized to its
 * own contents first, so the table (and the box around it) grows to fit.
 */
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

  interface Table {
    w: number
    h: number
    cols: number
    colW: number[]
    rowH: number[]
  }
  const tables = new Map<string, Table>()
  const size = (n: TeamNode, depth = 0): { w: number; h: number } => {
    if (n.kind !== 'box') return { w: CARD_W, h: CARD_H }
    const known = tables.get(n.id)
    if (known) return known
    const list = depth > 64 ? [] : (members.get(n.id) ?? [])
    const cols = boxCols(Math.max(list.length, 1))
    const rows = Math.max(1, Math.ceil(list.length / cols))
    const colW: number[] = Array.from({ length: cols }, () => (list.length ? 0 : CARD_W))
    const rowH: number[] = Array.from({ length: rows }, () => (list.length ? 0 : CARD_H))
    list.forEach((m, i) => {
      const s = size(m, depth + 1)
      colW[i % cols] = Math.max(colW[i % cols], s.w)
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], s.h)
    })
    const sum = (a: number[]): number => a.reduce((t, v) => t + v, 0)
    const table = {
      w: BOX_PAD * 2 + sum(colW) + (cols - 1) * BOX_GAP,
      h: BOX_HEADER + BOX_PAD + sum(rowH) + (rows - 1) * BOX_GAP,
      cols,
      colW,
      rowH
    }
    tables.set(n.id, table)
    return table
  }

  const placeContents = (box: TeamNode, x: number, y: number, depth: number): void => {
    const list = depth > 64 ? [] : (members.get(box.id) ?? [])
    const t = tables.get(box.id) ?? (size(box), tables.get(box.id)!)
    boxes.set(box.id, { members: list.map((m) => m.id), cols: t.cols })
    list.forEach((m, i) => {
      const c = i % t.cols
      const r = Math.floor(i / t.cols)
      const mx = x + BOX_PAD + t.colW.slice(0, c).reduce((s, v) => s + v, 0) + c * BOX_GAP
      const my = y + BOX_HEADER + t.rowH.slice(0, r).reduce((s, v) => s + v, 0) + r * BOX_GAP
      const s = size(m)
      rects.set(m.id, { x: mx, y: my, w: s.w, h: s.h })
      if (m.kind === 'box') placeContents(m, mx, my, depth + 1)
    })
  }

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
    if (n.kind === 'box') placeContents(n, centreX - s.w / 2, top, 0)
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

/**
 * Where among a box's contents a drop at `p` would go: everything in the rows above
 * the pointer, and whatever in the pointer's own row is left of it. Read off the
 * layout, so it works for a table of mixed sizes as well as a grid of cards.
 */
export function slotIndex(l: Layout, boxId: string, p: { x: number; y: number }): number {
  const entry = l.boxes.get(boxId)
  if (!entry || !entry.members.length) return 0
  const rows: { top: number; bottom: number; ids: string[] }[] = []
  entry.members.forEach((id, i) => {
    const r = l.rects.get(id)
    if (!r) return
    const row = Math.floor(i / entry.cols)
    const band = rows[row] ?? (rows[row] = { top: r.y, bottom: r.y + r.h, ids: [] })
    band.top = Math.min(band.top, r.y)
    band.bottom = Math.max(band.bottom, r.y + r.h)
    band.ids.push(id)
  })
  let count = 0
  for (const row of rows) {
    if (!row) continue
    if (p.y > row.bottom + BOX_GAP / 2) {
      count += row.ids.length
      continue
    }
    if (p.y >= row.top - BOX_GAP / 2) {
      count += row.ids.filter((id) => {
        const r = l.rects.get(id)!
        return r.x + r.w / 2 < p.x
      }).length
    }
    break
  }
  return count
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
 * and what sat in a box takes the box's place: in the box around it if it was in one,
 * under its parent if it hung in the tree, or standing free exactly where it was —
 * nothing else on the board moves because one thing left.
 */
export function remove(chart: TeamChart, id: string, current: Layout): TeamChart {
  const gone = chart.nodes.find((n) => n.id === id)
  if (!gone) return chart
  const contents = chart.nodes.filter((n) => n.boxId === id).sort(byOrder).map((n) => n.id)
  const freeAt = (n: TeamNode): TeamNode => {
    const r = current.rects.get(n.id)
    return { ...n, boxId: null, parentId: null, x: snap(r?.x ?? n.x), y: snap(r?.y ?? n.y) }
  }
  let nodes = chart.nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      if (n.boxId === id) {
        if (gone.boxId) return { ...n, boxId: gone.boxId, parentId: null }
        if (gone.parentId) return { ...n, boxId: null, parentId: gone.parentId }
        return freeAt(n)
      }
      if (n.parentId === id) {
        if (gone.boxId) return { ...n, parentId: topBox(chart, gone.boxId) }
        if (gone.parentId) return { ...n, parentId: gone.parentId }
        return freeAt(n)
      }
      return n
    })
  // What was in the box stands where the box stood among its neighbours.
  const up = gone.boxId ?? gone.parentId
  if (up && contents.length) {
    const siblings = chart.nodes
      .filter((n) => (gone.boxId ? n.boxId === up : !n.boxId && n.parentId === up))
      .sort(byOrder)
      .map((n) => n.id)
    siblings.splice(Math.max(0, siblings.indexOf(id)), 1, ...contents)
    nodes = renumber(nodes, siblings)
  }
  return { version: 1, nodes }
}

/** Several off the board, one after another, as one change. */
export function removeAll(chart: TeamChart, ids: Iterable<string>, current: Layout): TeamChart {
  let out = chart
  for (const id of ids) out = remove(out, id, current)
  return out
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

  // Nothing goes into, or under, something it is carrying: that would be a loop.
  if (exists && carried(chart, node.id).has(target.id)) return chart

  if (target.kind === 'box') {
    const top = topBox({ version: 1, nodes }, target.id)
    nodes = nodes.map((n) => {
      if (n.id === node.id) return { ...n, boxId: target.id, parentId: null }
      // What reported to it now reports to the box it joined — the outermost one,
      // since nothing hangs under anything inside a box.
      if (n.parentId === node.id && !n.boxId) return { ...n, parentId: top }
      return n
    })
  } else {
    nodes = nodes.map((n) => (n.id === node.id ? { ...n, parentId: target.id, boxId: null } : n))
  }

  const order = siblingsOf(nodes, target, node.id)
  order.splice(Math.max(0, Math.min(target.index, order.length)), 0, node.id)
  return { version: 1, nodes: renumber(nodes, order) }
}

/**
 * Several let go at once, in the order given. Onto a card or into a box they line up
 * side by side from the slot the pointer chose; on open board each lands at its own
 * position from `at` (so a group keeps its shape); off the board, all of it goes.
 */
export function applyDropAll(
  chart: TeamChart,
  ids: string[],
  target: DropTarget,
  at?: Map<string, { x: number; y: number }>
): TeamChart {
  if (target.kind === 'remove') {
    const gone = new Set<string>()
    for (const id of ids) carried(chart, id).forEach((g) => gone.add(g))
    return { version: 1, nodes: chart.nodes.filter((n) => !gone.has(n.id)) }
  }
  const moving = ids.filter((id) => chart.nodes.some((n) => n.id === id))
  if (target.kind === 'free') {
    let out = chart
    for (const id of moving) {
      const node = out.nodes.find((n) => n.id === id)!
      const p = at?.get(id) ?? { x: target.x, y: target.y }
      out = applyDrop(out, node, { kind: 'free', x: p.x, y: p.y })
    }
    return out
  }
  for (const id of moving) if (carried(chart, id).has(target.id)) return chart
  // Lift them all first, so the ones already there do not count as neighbours.
  const lifted = new Set(moving)
  let out: TeamChart = {
    version: 1,
    nodes: chart.nodes.map((n) => (lifted.has(n.id) ? { ...n, parentId: null, boxId: null } : n))
  }
  moving.forEach((id, i) => {
    const node = out.nodes.find((n) => n.id === id)!
    out = applyDrop(out, node, { ...target, index: target.index + i })
  })
  return out
}

/** Up one step: the box a node sits in, else what it reports to. */
const upOf = (n: TeamNode | undefined): string | null => n?.boxId ?? n?.parentId ?? null

/**
 * Of a selection, the ones that move by themselves: those not already carried along
 * by another selected node (sitting in it, or hanging under it, at any distance).
 */
export function selectionRoots(chart: TeamChart, ids: Iterable<string>): string[] {
  const sel = new Set(ids)
  const byId = new Map(chart.nodes.map((n) => [n.id, n]))
  return [...sel].filter((id) => {
    if (!byId.has(id)) return false
    let up = upOf(byId.get(id))
    for (let i = 0; up && i < 256; i++) {
      if (sel.has(up)) return false
      up = upOf(byId.get(up))
    }
    return true
  })
}

/**
 * Of a selection, the ones that go *into* a box when it is dropped into one or grouped:
 * every selected node not already inside a selected box. Selected people who report to
 * each other all go in — inside a box there is no tree to keep.
 */
export function selectionJoiners(chart: TeamChart, ids: Iterable<string>): string[] {
  const sel = new Set(ids)
  const byId = new Map(chart.nodes.map((n) => [n.id, n]))
  return [...sel].filter((id) => {
    if (!byId.has(id)) return false
    let up = byId.get(id)?.boxId ?? null
    for (let i = 0; up && i < 256; i++) {
      if (sel.has(up)) return false
      up = byId.get(up)?.boxId ?? null
    }
    return true
  })
}

/** Ids in the order you read the board: top to bottom, then left to right. */
export function readingOrder(ids: Iterable<string>, l: Layout): string[] {
  return [...ids].sort((a, b) => {
    const ra = l.rects.get(a)
    const rb = l.rects.get(b)
    if (!ra || !rb) return ra ? -1 : rb ? 1 : 0
    return ra.y - rb.y || ra.x - rb.x
  })
}

/**
 * Put a selection in a new box. The box takes the place of the first of them: in the
 * box they all shared, under the parent they all shared, or on open board where their
 * top-left corner was.
 */
export function groupIntoBox(
  chart: TeamChart,
  ids: Iterable<string>,
  current: Layout,
  label = 'New box'
): { chart: TeamChart; boxId: string } | null {
  const joiners = readingOrder(selectionJoiners(chart, ids), current)
  if (!joiners.length) return null
  const byId = new Map(chart.nodes.map((n) => [n.id, n]))
  const first = byId.get(joiners[0])!
  const box: TeamNode = { id: uid(), kind: 'box', label, x: 0, y: 0 }
  const sharedBox = joiners.every((id) => byId.get(id)?.boxId === first.boxId) ? first.boxId : null
  const sharedParent = !sharedBox && joiners.every((id) => !byId.get(id)?.boxId && byId.get(id)?.parentId === first.parentId)
    ? first.parentId
    : null
  let out: TeamChart
  if (sharedBox || sharedParent) {
    const target: DropTarget = sharedBox
      ? { kind: 'box', id: sharedBox, index: 0 }
      : { kind: 'parent', id: sharedParent!, index: 0 }
    const siblings = siblingsOf(chart.nodes, target, '')
    const index = Math.min(...joiners.map((id) => siblings.indexOf(id)).filter((i) => i >= 0))
    out = applyDrop(chart, box, { ...target, index: Number.isFinite(index) ? index : siblings.length })
  } else {
    let x = Infinity
    let y = Infinity
    for (const id of joiners) {
      const r = current.rects.get(id)
      if (r) {
        x = Math.min(x, r.x)
        y = Math.min(y, r.y)
      }
    }
    out = applyDrop(chart, box, { kind: 'free', x: snap(Number.isFinite(x) ? x : 0), y: snap(Number.isFinite(y) ? y - BOX_HEADER : 0) })
  }
  out = applyDropAll(out, joiners, { kind: 'box', id: box.id, index: 0 })
  return { chart: out, boxId: box.id }
}

/* ------------------------------------------------------------------ copy and paste */

/** The marker that says a clipboard's text is a piece of a team chart. */
export const CLIP_MARKER = 'neo/team-chart'

export interface TeamClip {
  [CLIP_MARKER]: 1
  /** The project it was copied from, so a paste back into it can sit beside the originals. */
  projectId?: string
  /**
   * The copied nodes, with their own ids. Links point only inside the set; every node
   * carries the position it was drawn at, so whatever loses its link on the way in
   * (someone not on the project) still lands where it was.
   */
  nodes: TeamNode[]
  /** Names of the people in it, so a paste can say who it left out. */
  people: Record<string, string>
}

/** Is this clipboard text one of ours? Returns it parsed, or null. */
export function readClip(text: string | null | undefined): TeamClip | null {
  if (!text || !text.includes(CLIP_MARKER)) return null
  try {
    const v = JSON.parse(text) as TeamClip
    if (v?.[CLIP_MARKER] !== 1 || !Array.isArray(v.nodes)) return null
    return { ...v, people: v.people ?? {} }
  } catch {
    return null
  }
}

/**
 * What ⌘C takes: the selection, each selected box with everything in it, and the links
 * between them — a link to anything left behind is dropped, and what had one stands
 * free where it was drawn.
 */
export function copySelection(
  chart: TeamChart,
  ids: Iterable<string>,
  current: Layout,
  nameOf: (personId: string) => string,
  projectId?: string
): TeamClip | null {
  const set = new Set([...ids].filter((id) => chart.nodes.some((n) => n.id === id)))
  if (!set.size) return null
  let grew = true
  while (grew) {
    grew = false
    for (const n of chart.nodes) {
      if (!set.has(n.id) && n.boxId && set.has(n.boxId)) {
        set.add(n.id)
        grew = true
      }
    }
  }
  const people: Record<string, string> = {}
  const nodes = chart.nodes
    .filter((n) => set.has(n.id))
    .map((n) => {
      if (n.personId) people[n.personId] = nameOf(n.personId)
      const r = current.rects.get(n.id)
      return {
        ...n,
        x: r?.x ?? n.x,
        y: r?.y ?? n.y,
        parentId: n.parentId && set.has(n.parentId) ? n.parentId : null,
        boxId: n.boxId && set.has(n.boxId) ? n.boxId : null
      }
    })
  return { [CLIP_MARKER]: 1, projectId, nodes, people }
}

/**
 * A clip made ready to land on a board: fresh ids, people not on this project left
 * out (with whatever hung on them standing free), and the free-standing ones moved so
 * the whole piece is centred on `centre` — or, without one, shifted by `offset`.
 */
export function pasteClip(
  clip: TeamClip,
  onProject: Set<string>,
  place: { centre: { x: number; y: number } } | { offset: { x: number; y: number } }
): { nodes: TeamNode[]; skipped: string[] } {
  const skippedPeople = new Set<string>()
  const kept = clip.nodes.filter((n) => {
    if (n.kind === 'box') return true
    if (n.kind === 'person' && n.personId && onProject.has(n.personId)) return true
    if (n.personId) skippedPeople.add(n.personId)
    return false
  })
  const fresh = new Map(kept.map((n) => [n.id, uid()]))
  let nodes: TeamNode[] = kept.map((n) => {
    const boxId = n.boxId && fresh.has(n.boxId) ? fresh.get(n.boxId)! : null
    const parentId = !boxId && n.parentId && fresh.has(n.parentId) ? fresh.get(n.parentId)! : null
    return { ...n, id: fresh.get(n.id)!, boxId, parentId }
  })
  let dx: number
  let dy: number
  if ('centre' in place) {
    const b = bounds(layout({ version: 1, nodes }))
    dx = b ? place.centre.x - (b.x + b.w / 2) : 0
    dy = b ? place.centre.y - (b.y + b.h / 2) : 0
  } else {
    dx = place.offset.x
    dy = place.offset.y
  }
  // Move the piece by a whole number of grid steps, so what was on the grid stays on it.
  dx = snap(dx)
  dy = snap(dy)
  nodes = nodes.map((n) => (n.parentId || n.boxId ? n : { ...n, x: snap(n.x + dx), y: snap(n.y + dy) }))
  return { nodes, skipped: [...skippedPeople].map((id) => clip.people[id] ?? 'Someone') }
}

/** The sentence for what letting go would do, said while it is still undecided. */
export function describeDrop(
  target: DropTarget | null,
  who: string,
  nameOf: (nodeId: string) => string,
  plural = false
): string {
  if (!target) return ''
  switch (target.kind) {
    case 'parent':
      return `${who} ${plural ? 'report' : 'reports'} to ${nameOf(target.id)}`
    case 'box':
      return `${who} ${plural ? 'join' : 'joins'} ${nameOf(target.id)}`
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
