import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import { classify, fenced, inlines, type Block } from '@/lib/markdown'
import { openExternal } from '@/lib/api'

/**
 * A Markdown editor that renders what you write where you write it.
 *
 * The note is plain Markdown and stays plain Markdown — every character you type is
 * still in the string that gets saved. What changes is how the line *looks* the moment
 * the syntax is complete: type `## ` and the line becomes a heading with the cursor
 * still in it, type `- ` and it becomes a bullet. The syntax that has a visual form of
 * its own — a bullet, a number, a checkbox, a quote bar — is drawn instead of shown;
 * the rest (`##`, `**`, a link's brackets) hides on every line except the one you are
 * working on, where you need to be able to edit it.
 *
 * That cannot be a textarea: a textarea has one font for the whole box. So this is a
 * `contenteditable`, and the price of a contenteditable is that the browser will
 * happily rearrange it into something that no longer round-trips. It is paid the only
 * way that works: **every** edit is intercepted at `beforeinput`, applied to the
 * Markdown string, and the DOM is redrawn from that string. The document you can see
 * is therefore always a rendering of the text, never a source of it, and the caret is
 * carried across by character offset. Undo is ours for the same reason — redrawing the
 * DOM would have thrown the browser's own history away.
 */

const INDENT = '  '

export function MarkdownEditor({
  value,
  onChange,
  placeholder = '',
  autoFocus,
  className = ''
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const text = useRef(value)
  text.current = value

  /** The line the cursor is on, which is the only one that shows its syntax. */
  const active = useRef(-1)
  /** Where the caret belongs after the next redraw, in characters from the start. */
  const caret = useRef<number | null>(autoFocus ? 0 : null)
  /** Guards our own selection changes against the listener watching for them. */
  const settling = useRef(false)
  const composing = useRef(false)
  /** What each line was last drawn from, so an untouched line is left alone. */
  const drawn = useRef<string[]>([])
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const merged = useRef(0)
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  /** Replaces the whole text. Undo needs this — a snapshot is not a range edit. */
  const write = useCallback(
    (next: string, at: number, remember?: Snapshot, coalesce = false): void => {
      const now = Date.now()
      if (remember) {
        future.current = []
        if (!coalesce || now - merged.current > 700 || past.current.length === 0) {
          past.current.push(remember)
          if (past.current.length > 300) past.current.shift()
        }
        merged.current = now
      }
      caret.current = at
      if (next === text.current) redraw()
      else onChange(next)
    },
    [onChange]
  )

  const splice = useCallback(
    (from: number, to: number, insert: string, at?: number, coalesce = false): void => {
      const before = text.current
      write(
        before.slice(0, from) + insert + before.slice(to),
        at ?? from + insert.length,
        { text: before, caret: from },
        coalesce
      )
    },
    [write]
  )

  /** Where the caret is now, in characters, or null if it is not in here. */
  const where = useCallback((): [number, number] | null => {
    const el = root.current
    const sel = document.getSelection()
    if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return null
    const starts = lineStarts(text.current)
    const a = offsetOf(el, sel.anchorNode, sel.anchorOffset, starts)
    const b = sel.focusNode ? offsetOf(el, sel.focusNode, sel.focusOffset, starts) : a
    return a <= b ? [a, b] : [b, a]
  }, [])

  // Draws the document, then puts the caret back. Both have to happen in the same
  // frame: between replacing a line and restoring the cursor there is no cursor.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const lines = value.split('\n')
    const starts = lineStarts(value)
    const at = caret.current
    if (at !== null) active.current = lineAt(starts, at)

    const codes = fenced(lines)
    const keys = lines.map((line, i) => `${codes[i] ? 1 : 0}|${i === active.current ? 1 : 0}|${line}`)
    for (let i = 0; i < lines.length; i++) {
      if (drawn.current[i] === keys[i] && el.children[i]) continue
      const node = draw(lines[i], codes[i], i === active.current, i)
      if (el.children[i]) el.replaceChild(node, el.children[i])
      else el.appendChild(node)
    }
    while (el.children.length > lines.length) el.removeChild(el.lastChild as Node)
    drawn.current = keys
    el.dataset.empty = value ? '' : '1'

    if (at !== null) {
      settling.current = true
      put(el, at, starts)
      caret.current = null
      queueMicrotask(() => {
        settling.current = false
      })
    }
  })

  useEffect(() => {
    if (autoFocus) root.current?.focus()
  }, [autoFocus])

  // Moving the cursor to another line changes which line shows its syntax, so the
  // document has to be redrawn for a selection change as much as for an edit.
  useEffect(() => {
    const onSelect = (): void => {
      if (settling.current || composing.current) return
      const range = where()
      if (!range) return
      const line = lineAt(lineStarts(text.current), range[0])
      if (line === active.current) return
      active.current = line
      caret.current = range[0]
      redraw()
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [where])

  /*
   * The whole contract in one handler: nothing the browser wants to do to the document
   * is allowed through, and everything it wanted to do is done to the string instead.
   * `getTargetRanges()` is what makes that affordable — the browser has already worked
   * out what "delete the previous word" means, and hands over the range it would touch.
   */
  useEffect(() => {
    const el = root.current
    if (!el) return

    const onBefore = (e: InputEvent): void => {
      if (composing.current || e.inputType === 'insertCompositionText') return
      const starts = lineStarts(text.current)
      const target = e.getTargetRanges()[0]
      const here = where()
      let from = here ? here[0] : 0
      let to = here ? here[1] : 0
      if (target) {
        from = offsetOf(el, target.startContainer, target.startOffset, starts)
        to = offsetOf(el, target.endContainer, target.endOffset, starts)
        if (from > to) [from, to] = [to, from]
      }
      e.preventDefault()

      switch (e.inputType) {
        case 'insertText':
          splice(from, to, e.data ?? '', undefined, from === to && (e.data ?? '') !== ' ')
          return
        // Chromium picks between the two by where in the block structure the caret
        // is — Return at the end of an empty list item comes through as a line break.
        // In Markdown a newline is a newline, so both take the same path.
        case 'insertParagraph':
        case 'insertLineBreak':
          enter(from, to, text.current, splice)
          return
        case 'insertFromPaste':
        case 'insertFromDrop': {
          const pasted = e.dataTransfer?.getData('text/plain') ?? ''
          if (from !== to && /^https?:\/\/\S+$/.test(pasted.trim())) {
            const label = text.current.slice(from, to)
            splice(from, to, `[${label}](${pasted.trim()})`)
          } else splice(from, to, pasted.replace(/\r\n?/g, '\n'))
          return
        }
        default:
          if (e.inputType.startsWith('delete')) {
            if (from === to && from > 0) splice(from - 1, from, '')
            else splice(from, to, '')
          }
      }
    }

    el.addEventListener('beforeinput', onBefore as EventListener)
    return () => el.removeEventListener('beforeinput', onBefore as EventListener)
  }, [splice, where])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (composing.current) return
      const meta = e.metaKey || e.ctrlKey
      const range = where()
      if (!range) return
      const [from, to] = range
      const source = text.current

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.stopPropagation()
        const stack = e.shiftKey ? future : past
        const other = e.shiftKey ? past : future
        const step = stack.current.pop()
        if (!step) return
        other.current.push({ text: source, caret: from })
        merged.current = 0
        write(step.text, step.caret)
        return
      }

      if (meta && !e.altKey) {
        const key = e.key.toLowerCase()
        const pair =
          key === 'b' ? '**' : key === 'i' ? '*' : key === 'e' ? '`' : ''
        if (pair) {
          e.preventDefault()
          e.stopPropagation()
          wrap(source, from, to, pair, splice)
          return
        }
        // ⌘K stays with the command palette; a link is one keystroke further along.
        if (key === 'k' && e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          const selected = source.slice(from, to)
          if (/^https?:\/\/\S+$/.test(selected)) splice(from, to, `[](${selected})`, from + 1)
          else splice(from, to, `[${selected}]()`, from + selected.length + 3)
          return
        }
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        nudge(source, from, to, e.shiftKey ? -1 : 1, write)
        return
      }

      // Backspace where the words start takes the marker off rather than eating into
      // it: the way out of a list is to unmake the item, not to chew through `- `.
      if (e.key === 'Backspace' && from === to) {
        const starts = lineStarts(source)
        const i = lineAt(starts, from)
        const raw = source.split('\n')[i]
        const b = classify(raw, fenced(source.split('\n'))[i])
        if (b.marker && from === starts[i] + b.indent.length + b.marker.length) {
          e.preventDefault()
          e.stopPropagation()
          if (b.indent.length) {
            const cut = Math.min(INDENT.length, b.indent.length)
            splice(starts[i], starts[i] + cut, '')
          } else {
            splice(starts[i], starts[i] + b.marker.length, '')
          }
        }
      }
    },
    [splice, where, write]
  )

  /*
   * The selection only ever holds what is on screen, and what is on screen is missing
   * every marker this editor hides. Copying has to take the Markdown instead.
   */
  const onClip = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
      const range = where()
      if (!range || range[0] === range[1]) return
      e.preventDefault()
      e.clipboardData.setData('text/plain', text.current.slice(range[0], range[1]))
      if (cut) splice(range[0], range[1], '')
    },
    [splice, where]
  )

  return (
    <div className="relative">
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        className={`mde outline-none ${className}`}
        onKeyDown={onKeyDown}
        onCopy={(e) => onClip(e, false)}
        onCut={(e) => onClip(e, true)}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
          const el = root.current
          if (!el) return
          // The browser wrote into the document directly; take its word for it once,
          // then redraw from the string so everything is back under control.
          const next = [...el.children].map((line) => line.textContent ?? '').join('\n')
          drawn.current = []
          const range = where()
          write(next, range ? range[1] : next.length, { text: text.current, caret: 0 })
        }}
        onMouseDown={(e) => {
          const target = e.target as HTMLElement
          const box = target.closest('[data-task]')
          if (box) {
            e.preventDefault()
            const i = Number((box.closest('.ln') as HTMLElement).dataset.i)
            toggle(text.current, i, splice)
            return
          }
          const link = target.closest('[data-href]') as HTMLElement | null
          if (link && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            openExternal(link.dataset.href as string)
          }
        }}
      />
      {!value && (
        <div className="pointer-events-none absolute inset-x-0 top-0 select-none text-base-content/30">
          {placeholder}
        </div>
      )}
    </div>
  )
}

interface Snapshot {
  text: string
  caret: number
}

type Splice = (from: number, to: number, insert: string, at?: number, coalesce?: boolean) => void

/* ---------------------------------------------------------------- drawing */

function draw(raw: string, inCode: boolean, on: boolean, index: number): HTMLElement {
  const b = classify(raw, inCode)
  const line = document.createElement('div')
  line.className = 'ln'
  line.dataset.i = String(index)
  line.dataset.b = b.kind
  if (on) line.dataset.on = '1'

  if (b.kind === 'code') {
    line.append(document.createTextNode(raw))
    if (!raw) line.append(document.createElement('br'))
    return line
  }

  const depth = Math.floor(b.indent.length / 2)
  if (depth) line.style.paddingLeft = `${depth * 1.5}em`
  if (b.indent) line.append(mark(b.indent, true))
  if (b.marker) line.append(mark(b.marker, b.structural || !on))

  // The marker drawn as the thing it means. These carry no text of their own, so the
  // Markdown the document serialises back to is unaffected by them.
  if (b.kind === 'bullet') line.append(figure('bul'))
  if (b.kind === 'number') line.append(figure('num', b.ordinal))
  if (b.kind === 'task') {
    const box = figure(b.checked ? 'box on' : 'box')
    box.dataset.task = '1'
    line.append(box)
  }

  let visible = b.text.length > 0 || (Boolean(b.marker) && !b.structural && on)
  for (const token of inlines(b.text)) {
    if (token.kind === 'text') {
      line.append(document.createTextNode(token.body))
      continue
    }
    if (token.open) line.append(mark(token.open, !on))
    const el = document.createElement(TAG[token.kind])
    el.textContent = token.body
    if (token.kind === 'link') {
      el.className = 'lk'
      el.dataset.href = token.href
      el.title = `${token.href} — ⌘-click to open`
    }
    line.append(el)
    if (token.close) line.append(mark(token.close, !on))
  }

  if (b.kind === 'task') visible = true
  if (!visible) line.append(document.createElement('br'))
  return line
}

const TAG: Record<string, string> = {
  strong: 'b',
  em: 'i',
  code: 'code',
  strike: 's',
  link: 'span'
}

function mark(chars: string, hide: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mk'
  el.textContent = chars
  if (hide) el.dataset.h = '1'
  return el
}

/** Empty on purpose: it draws through CSS, so it contributes nothing to the text. */
function figure(className: string, ordinal = ''): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.contentEditable = 'false'
  if (ordinal) el.dataset.n = ordinal
  return el
}

/* ------------------------------------------------------- text and offsets */

function lineStarts(source: string): number[] {
  const out: number[] = []
  let at = 0
  for (const line of source.split('\n')) {
    out.push(at)
    at += line.length + 1
  }
  return out
}

function lineAt(starts: number[], offset: number): number {
  let i = starts.length - 1
  while (i > 0 && starts[i] > offset) i--
  return i
}

/** A position in the drawn document, as a position in the Markdown behind it. */
function offsetOf(root: HTMLElement, node: Node, offset: number, starts: number[]): number {
  const from = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const line = from?.closest('.ln') as HTMLElement | null
  if (!line) {
    const i = Math.min(Math.max(offset, 0), Math.max(starts.length - 1, 0))
    return starts[i] ?? 0
  }

  let within = 0
  if (node.nodeType !== Node.TEXT_NODE) {
    const kids = node.childNodes
    for (let k = 0; k < offset && k < kids.length; k++) within += kids[k].textContent?.length ?? 0
  }

  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === node) return starts[Number(line.dataset.i)] + within + offset
    if (node.nodeType !== Node.TEXT_NODE && node.contains(n)) break
    within += n.textContent?.length ?? 0
  }
  return starts[Number(line.dataset.i)] + within
}

/** The inverse, skipping the markers that are currently drawn as nothing. */
function put(root: HTMLElement, offset: number, starts: number[]): void {
  const i = lineAt(starts, offset)
  const line = root.children[i] as HTMLElement | undefined
  if (!line) return
  const target = offset - starts[i]

  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let at = 0
  let after: { node: Node; offset: number } | null = null
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const length = n.textContent?.length ?? 0
    if (!(n.parentElement as HTMLElement | null)?.closest('[data-h]')) {
      if (at <= target && target <= at + length) return select(n, target - at)
      if (at > target && !after) after = { node: n, offset: 0 }
    }
    at += length
  }
  if (after) select(after.node, after.offset)
  else select(line, 0)
}

function select(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/* ------------------------------------------------------------ the editing */

/** What the next line starts with when Return is pressed inside this one. */
function carry(b: Block): string {
  if (b.kind === 'bullet' || b.kind === 'quote') return b.indent + b.marker
  if (b.kind === 'task') return `${b.indent}${b.marker.slice(0, b.marker.indexOf('['))}[ ] `
  if (b.kind === 'number') {
    const delim = b.ordinal.slice(-1)
    return `${b.indent}${Number(b.ordinal.slice(0, -1)) + 1}${delim}${b.marker.slice(b.ordinal.length)}`
  }
  return ''
}

function enter(from: number, to: number, source: string, splice: Splice): void {
  const starts = lineStarts(source)
  const i = lineAt(starts, from)
  const lines = source.split('\n')
  const b = classify(lines[i], fenced(lines)[i])

  // Return on an item with nothing in it means you are finished with the list.
  if (from === to && b.marker && b.structural && !b.text.trim()) {
    if (b.indent.length) {
      const cut = Math.min(INDENT.length, b.indent.length)
      splice(starts[i], starts[i] + cut, '')
    } else splice(starts[i], starts[i] + b.marker.length, '')
    return
  }

  const next = `\n${carry(b)}`
  splice(from, to, next)
}

function wrap(source: string, from: number, to: number, pair: string, splice: Splice): void {
  const n = pair.length
  const selected = source.slice(from, to)
  if (source.slice(from - n, from) === pair && source.slice(to, to + n) === pair) {
    splice(from - n, to + n, selected, from - n)
    return
  }
  if (selected.length > n * 2 && selected.startsWith(pair) && selected.endsWith(pair)) {
    splice(from, to, selected.slice(n, -n), from)
    return
  }
  splice(from, to, pair + selected + pair, from + n)
}

/** Tab nests, Shift-Tab lifts, across every line the selection touches. */
function nudge(
  source: string,
  from: number,
  to: number,
  direction: 1 | -1,
  write: (next: string, at: number, remember?: Snapshot, coalesce?: boolean) => void
): void {
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const first = lineAt(starts, from)
  const last = lineAt(starts, to)
  let moved = 0
  let firstMoved = 0

  for (let i = first; i <= last; i++) {
    if (direction === 1) {
      lines[i] = INDENT + lines[i]
      if (i === first) firstMoved = INDENT.length
      moved += INDENT.length
    } else {
      const cut = lines[i].startsWith(INDENT) ? INDENT.length : lines[i].startsWith(' ') ? 1 : 0
      lines[i] = lines[i].slice(cut)
      if (i === first) firstMoved = -cut
      moved -= cut
    }
  }
  if (!moved) return
  write(lines.join('\n'), Math.max(starts[first], (first === last ? to : from) + firstMoved), {
    text: source,
    caret: from
  })
}

function toggle(source: string, index: number, splice: Splice): void {
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const b = classify(lines[index], false)
  if (b.kind !== 'task') return
  const box = starts[index] + b.indent.length + b.marker.indexOf('[') + 1
  splice(box, box + 1, b.checked ? ' ' : 'x', box + 1)
}
