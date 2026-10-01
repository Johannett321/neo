/*
 * The team chart's pure half (`renderer/src/lib/team.ts`), checked on its own: what a
 * chart means, where everything goes, and what each gesture does to it. No server and
 * no window — `npm run verify:team`. These are also the invariants another client has
 * to keep to draw the same chart, so they are written to be read.
 */
import type { CastMember, TeamChart, TeamNode } from '../src/shared/types'
import {
  BOX_GAP,
  BOX_HEADER,
  BOX_PAD,
  CARD_H,
  CARD_W,
  CLIP_MARKER,
  applyDrop,
  applyDropAll,
  carried,
  copySelection,
  depthOf,
  groupIntoBox,
  layout,
  pasteClip,
  readClip,
  remove,
  removeAll,
  sanitize,
  selectionJoiners,
  selectionRoots,
  slotIndex
} from '../src/renderer/src/lib/team'

let failed = 0
const ok = (label: string, condition: boolean): void => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failed++
}

const cast = (...ids: string[]): CastMember[] =>
  ids.map((personId) => ({ id: `m-${personId}`, personId, name: personId.toUpperCase(), role: '' }) as unknown as CastMember)
const person = (id: string, extra: Partial<TeamNode> = {}): TeamNode => ({ id, kind: 'person', personId: id, x: 0, y: 0, ...extra })
const box = (id: string, extra: Partial<TeamNode> = {}): TeamNode => ({ id, kind: 'box', label: id, x: 0, y: 0, ...extra })
const chart = (...nodes: TeamNode[]): TeamChart => ({ version: 1, nodes })
const find = (c: TeamChart, id: string): TeamNode => c.nodes.find((n) => n.id === id)!
const everyone = cast('a', 'b', 'c', 'd', 'e', 'f', 'g')

/* -------------------------------------------------------------- old charts draw as they did */
{
  // A version-1 chart from before boxes could nest: a lead, a box of three under them.
  const old = chart(
    person('a', { x: 96, y: 48 }),
    box('B', { parentId: 'a', order: 0 }),
    person('b', { boxId: 'B', order: 0 }),
    person('c', { boxId: 'B', order: 1 }),
    person('d', { boxId: 'B', order: 2 }),
    person('e', { parentId: 'a', order: 1 })
  )
  const l = layout(sanitize(old, everyone))
  const B = l.rects.get('B')!
  ok('a box of three cards is the grid it always was',
    B.w === BOX_PAD * 2 + 3 * CARD_W + 2 * BOX_GAP && B.h === BOX_HEADER + BOX_PAD + CARD_H)
  ok('cards sit in the grid left to right',
    l.rects.get('c')!.x === B.x + BOX_PAD + CARD_W + BOX_GAP && l.rects.get('c')!.y === B.y + BOX_HEADER)
  const empty = layout(chart(box('E')))
  ok('an empty box keeps room for one card',
    empty.rects.get('E')!.w === BOX_PAD * 2 + CARD_W && empty.rects.get('E')!.h === BOX_HEADER + BOX_PAD + CARD_H)
  ok('the tree hangs the box and the card under the lead', l.edges.length === 2)
  const five = layout(chart(box('F'), ...['a', 'b', 'c', 'd', 'e'].map((id, i) => person(id, { boxId: 'F', order: i }))))
  ok('five cards make three columns and two rows',
    five.rects.get('F')!.w === BOX_PAD * 2 + 3 * CARD_W + 2 * BOX_GAP &&
    five.rects.get('F')!.h === BOX_HEADER + BOX_PAD + 2 * CARD_H + BOX_GAP &&
    five.rects.get('d')!.y === five.rects.get('a')!.y + CARD_H + BOX_GAP)
}

/* -------------------------------------------------------------- sanitize */
{
  const s = sanitize(chart(person('a'), person('zz'), box('B'), { id: 'q', kind: 'blob', x: 0, y: 0 } as unknown as TeamNode, person('a')), everyone)
  ok('people off the project, unknown kinds and repeated ids are dropped', s.nodes.map((n) => n.id).join() === 'a,B')

  const links = sanitize(chart(person('a', { boxId: 'b' }), person('b', { parentId: 'nope' }), box('B', { boxId: 'B' }), person('c', { boxId: 'B', parentId: 'a' })), everyone)
  ok('boxId must name a box, never itself', !find(links, 'a').boxId && !find(links, 'B').boxId)
  ok('a parent that is not there is dropped', !find(links, 'b').parentId)
  ok('sitting in a box wins over hanging under something', find(links, 'c').boxId === 'B' && !find(links, 'c').parentId)

  const nested = sanitize(chart(box('O'), box('I', { boxId: 'O' }), person('a', { boxId: 'I' })), everyone)
  ok('a box may sit in a box', find(nested, 'I').boxId === 'O' && find(nested, 'a').boxId === 'I')
  ok('depth counts the boxes around a node', depthOf(nested, 'a') === 2 && depthOf(nested, 'O') === 0)

  const cycle = sanitize(chart(box('X', { boxId: 'Y' }), box('Y', { boxId: 'Z' }), box('Z', { boxId: 'X' }), person('a', { boxId: 'Z' })), everyone)
  ok('a ring of boxes is broken at the first box listed', !find(cycle, 'X').boxId && find(cycle, 'Y').boxId === 'Z' && find(cycle, 'Z').boxId === 'X')
  const swapped = sanitize(chart(box('Z', { boxId: 'X' }), box('Y', { boxId: 'Z' }), box('X', { boxId: 'Y' })), everyone)
  ok('…and the order of the document decides which', !find(swapped, 'Z').boxId && find(swapped, 'X').boxId === 'Y')
  ok('a box inside itself through a chain is impossible after sanitize', (() => {
    for (const n of cycle.nodes) {
      let cur = n.boxId
      for (let i = 0; cur && i < 10; i++) {
        if (cur === n.id) return false
        cur = find(cycle, cur).boxId
      }
    }
    return true
  })())

  const into = sanitize(chart(box('O', { x: 0, y: 0 }), box('I', { boxId: 'O' }), person('a', { boxId: 'I' }), person('b', { parentId: 'a' }), person('c', { parentId: 'I' })), everyone)
  ok('what reports to anything inside boxes reports to the outermost box', find(into, 'b').parentId === 'O' && find(into, 'c').parentId === 'O')

  const mixed = sanitize(chart(box('B', { parentId: 'a' }), person('a', { boxId: 'B' })), everyone)
  ok('a box hanging under its own member is cut free', !find(mixed, 'B').parentId && find(mixed, 'a').boxId === 'B')

  const loop = sanitize(chart(person('a', { parentId: 'b' }), person('b', { parentId: 'a' })), everyone)
  ok('a reporting loop is cut at the first node listed', !find(loop, 'a').parentId && find(loop, 'b').parentId === 'a')
}

/* -------------------------------------------------------------- layout of nested boxes */
{
  const c = sanitize(chart(
    box('O', { x: 0, y: 0 }),
    person('a', { boxId: 'O', order: 0 }),
    box('I', { boxId: 'O', order: 1 }),
    person('b', { boxId: 'I', order: 0 }),
    person('c', { boxId: 'I', order: 1 })
  ), everyone)
  const l = layout(c)
  const O = l.rects.get('O')!
  const I = l.rects.get('I')!
  ok('a nested box is sized to its own contents', I.w === BOX_PAD * 2 + 2 * CARD_W + BOX_GAP && I.h === BOX_HEADER + BOX_PAD + CARD_H)
  ok('the outer box grows to fit it', O.w === BOX_PAD * 2 + CARD_W + BOX_GAP + I.w && O.h === BOX_HEADER + BOX_PAD + I.h)
  ok('the nested box takes the next cell', I.x === O.x + BOX_PAD + CARD_W + BOX_GAP && I.y === O.y + BOX_HEADER)
  ok('its cards sit inside it', l.rects.get('b')!.x === I.x + BOX_PAD && l.rects.get('b')!.y === I.y + BOX_HEADER)
  const inside = (r: { x: number; y: number; w: number; h: number }, o: typeof r): boolean =>
    r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h
  ok('everything in a box is drawn inside it', inside(I, O) && inside(l.rects.get('c')!, I) && inside(l.rects.get('a')!, O))
  ok('slot index: before everything, between, after', slotIndex(l, 'O', { x: O.x, y: O.y + 50 }) === 0 &&
    slotIndex(l, 'O', { x: I.x + 1, y: I.y + 20 }) === 1 && slotIndex(l, 'O', { x: O.x, y: O.y + O.h + 40 }) === 2)
}

/* -------------------------------------------------------------- gestures */
{
  const base = sanitize(chart(box('O', { x: 0, y: 0 }), box('I', { boxId: 'O', order: 0 }), person('a', { boxId: 'I', order: 0 }), person('b', { x: 600, y: 0 }), person('c', { parentId: 'b' })), everyone)
  ok('a box can be dropped into a box', find(applyDrop(base, find(base, 'b'), { kind: 'box', id: 'O', index: 0 }), 'b').boxId === 'O')
  const boxedB = applyDrop(base, find(base, 'b'), { kind: 'box', id: 'I', index: 0 })
  ok('what reported to someone who joins a nested box reports to the outermost box', find(boxedB, 'c').parentId === 'O')
  ok('a box cannot go into a box it carries', applyDrop(base, find(base, 'O'), { kind: 'box', id: 'I', index: 0 }) === base)
  const out = applyDrop(base, find(base, 'I'), { kind: 'free', x: 480, y: 480 })
  ok('dragging a box out of its parent stands it free, contents and all', !find(out, 'I').boxId && find(out, 'a').boxId === 'I')

  const l = layout(base)
  const gone = remove(base, 'I', l)
  ok('removing a nested box puts its contents in the box around it', find(gone, 'a').boxId === 'O')
  const goneTop = remove(sanitize(chart(box('O', { x: 0, y: 0 }), person('a', { boxId: 'O' })), everyone), 'O', layout(chart(box('O', { x: 0, y: 0 }), person('a', { boxId: 'O' }))))
  ok('removing a free box stands its contents free where they were', !find(goneTop, 'a').boxId && find(goneTop, 'a').x === 24 && find(goneTop, 'a').y === 48)
  const many = removeAll(base, ['b', 'I'], l)
  ok('removing several is one result', !many.nodes.some((n) => n.id === 'b' || n.id === 'I') && find(many, 'c').parentId === null)

  const sel = ['O', 'a', 'b', 'c']
  ok('roots are the selected nodes nothing selected carries', selectionRoots(base, sel).sort().join() === 'O,b')
  ok('joiners are the selected nodes not inside a selected box', selectionJoiners(base, sel).sort().join() === 'O,b,c')

  const two = sanitize(chart(person('a', { x: 0, y: 0 }), person('b', { x: 0, y: 400 }), person('c', { x: 600, y: 0 }), person('d', { parentId: 'a', order: 0 })), everyone)
  const onto = applyDropAll(two, ['b', 'c'], { kind: 'parent', id: 'a', index: 0 })
  ok('a group dropped on someone reports to them in order, from the slot',
    find(onto, 'b').parentId === 'a' && find(onto, 'c').parentId === 'a' &&
    find(onto, 'b').order === 0 && find(onto, 'c').order === 1 && find(onto, 'd').order === 2)
  const freed = applyDropAll(two, ['b', 'c'], { kind: 'free', x: 0, y: 0 }, new Map([['b', { x: 48, y: 448 }], ['c', { x: 648, y: 48 }]]))
  ok('a group dropped on open board keeps its shape', find(freed, 'b').x === 48 && find(freed, 'c').x === 648 && find(freed, 'c').y === 48)
  const offBoard = applyDropAll(two, ['a'], { kind: 'remove' })
  ok('a group dragged off the board takes what it carries', offBoard.nodes.map((n) => n.id).join() === 'b,c')

  const grouped = groupIntoBox(two, ['b', 'c'], layout(two))!
  ok('group into box makes one box with both in reading order',
    find(grouped.chart, 'c').boxId === grouped.boxId && find(grouped.chart, 'b').boxId === grouped.boxId &&
    find(grouped.chart, 'c').order! < find(grouped.chart, 'b').order!)
  const inTree = sanitize(chart(person('a', { x: 0, y: 0 }), person('b', { parentId: 'a', order: 0 }), person('c', { parentId: 'a', order: 1 }), person('d', { parentId: 'a', order: 2 })), everyone)
  const g2 = groupIntoBox(inTree, ['c', 'd'], layout(inTree))!
  ok('grouping siblings puts the box where the first of them was', find(g2.chart, g2.boxId).parentId === 'a' && find(g2.chart, g2.boxId).order === 1)
  const g3 = groupIntoBox(base, ['I', 'b'], layout(base))!
  ok('grouping can put a box in a new box', find(g3.chart, 'I').boxId === g3.boxId && find(g3.chart, 'a').boxId === 'I')
}

/* -------------------------------------------------------------- copy and paste */
{
  const base = sanitize(chart(box('O', { x: 0, y: 0 }), box('I', { boxId: 'O', order: 0 }), person('a', { boxId: 'I' }), person('b', { x: 600, y: 0 }), person('c', { parentId: 'b' }), person('d', { parentId: 'c' })), everyone)
  const l = layout(base)
  const clip = copySelection(base, ['O', 'c', 'd'], l, (id) => id.toUpperCase(), 'p1')!
  ok('copying a box takes everything in it', clip.nodes.map((n) => n.id).sort().join() === 'I,O,a,c,d')
  ok('links to what was left behind are dropped, links inside kept', find({ version: 1, nodes: clip.nodes }, 'c').parentId === null && find({ version: 1, nodes: clip.nodes }, 'd').parentId === 'c')
  const text = JSON.stringify(clip)
  ok('the clipboard text carries the marker and reads back', !!readClip(text) && readClip('{"nodes":[]}') === null && readClip('hello') === null && text.includes(`"${CLIP_MARKER}":1`))

  const pasted = pasteClip(readClip(text)!, new Set(['a', 'd']), { offset: { x: 48, y: 48 } })
  ok('a paste gets new ids', !pasted.nodes.some((n) => ['O', 'I', 'a', 'c', 'd'].includes(n.id)))
  ok('people not on the project are left out, and named', pasted.nodes.filter((n) => n.kind === 'person').length === 2 && pasted.skipped.join() === 'C')
  const p = { version: 1 as const, nodes: pasted.nodes }
  const d = pasted.nodes.find((n) => n.personId === 'd')!
  const origD = find({ version: 1, nodes: clip.nodes }, 'd')
  ok('what hung on someone left out stands free where it was, offset', !d.parentId && d.x % 24 === 0 && Math.abs(d.x - (origD.x + 48)) <= 12)
  const newO = pasted.nodes.find((n) => n.label === 'O')!
  const newI = pasted.nodes.find((n) => n.label === 'I')!
  ok('boxes inside boxes paste as boxes inside boxes', newI.boxId === newO.id && pasted.nodes.find((n) => n.personId === 'a')!.boxId === newI.id)
  ok('the pasted piece is a valid chart by itself', sanitize(p, everyone).nodes.length === p.nodes.length)

  const centred = pasteClip(clip, new Set(['a', 'c', 'd']), { centre: { x: 2400, y: 2400 } })
  const cl = layout({ version: 1, nodes: centred.nodes })
  let minX = Infinity
  let maxX = -Infinity
  cl.rects.forEach((r) => { minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w) })
  ok('a paste at the pointer is centred on it (to the grid)', Math.abs((minX + maxX) / 2 - 2400) <= 24)
  ok('carried() of a pasted box covers its nested contents', carried({ version: 1, nodes: centred.nodes }, centred.nodes.find((n) => n.label === 'O')!.id).size === 3)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
