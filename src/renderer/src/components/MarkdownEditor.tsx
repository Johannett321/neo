import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState
} from 'react'
import {
  classify, depthOf, inlines, isListItem, layout,
  type Block, type CalloutType, type LineContext, type Table
} from '@/lib/markdown'
import { openExternal } from '@/lib/api'
import { iconPath, type IconName } from './Icon'

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
 * carried across by character offset — both ends of it, so a selection survives the
 * redraw that moving it causes. Undo is ours for the same reason — redrawing the DOM
 * would have thrown the browser's own history away.
 *
 * Lists get the most care because they are where writing happens. An ordered list
 * numbers itself, but only the run being edited: Obsidian once renumbered whole
 * documents and had to walk it back. ⌥↑/⌥↓ move an item with everything nested
 * under it. Tab nests only where nesting means something.
 */

const INDENT = '  '
/** One level of nesting, and the width of a list's gutter, in em. */
const STEP = 1.5
const GUTTER = 1.75

export interface EditorHandle {
  focus(at?: 'start' | 'end'): void
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = '',
  autoFocus,
  className = '',
  ref,
  linkTargets = [],
  onOpenLink,
  onImage
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
  ref?: React.Ref<EditorHandle>
  /** What `[[` can complete to: the titles of the notes this one may link to. */
  linkTargets?: string[]
  /** ⌘-click on a `[[link]]`. */
  onOpenLink?: (target: string) => void
  /** A picture dropped or pasted in. Resolves to what to write, or null to refuse. */
  onImage?: (file: File) => Promise<{ url: string; alt: string } | null>
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const text = useRef(value)
  text.current = value

  /** The line the cursor is on, which is the only one that shows its syntax. */
  const active = useRef(-1)
  /** Where the selection belongs after the next redraw, in characters from the start. */
  const caret = useRef<Sel | null>(autoFocus ? { anchor: 0, focus: 0 } : null)
  /** Guards our own selection changes against the listener watching for them. */
  const settling = useRef(false)
  const composing = useRef(false)
  /** What each line was last drawn from, so an untouched line is left alone. */
  const drawn = useRef<string[]>([])
  /** The last value this editor produced. Anything else is a different document. */
  const produced = useRef(value)
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const merged = useRef(0)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const targets = useRef(linkTargets)
  targets.current = linkTargets
  const targetSig = useRef(linkTargets.join('\n'))
  const imageHandler = useRef(onImage)
  imageHandler.current = onImage

  /** Replaces the whole text. Undo needs this — a snapshot is not a range edit. */
  const write = useCallback(
    (next: string, at: number | Sel, remember?: Snapshot, coalesce = false): void => {
      const now = Date.now()
      if (remember) {
        future.current = []
        if (!coalesce || now - merged.current > 700 || past.current.length === 0) {
          past.current.push(remember)
          if (past.current.length > 300) past.current.shift()
        }
        merged.current = now
      }
      caret.current = typeof at === 'number' ? { anchor: at, focus: at } : at
      produced.current = next
      if (next === text.current) redraw()
      else onChange(next)
    },
    [onChange]
  )

  /**
   * One range edit. The lines the edit touched are renumbered afterwards, so an
   * ordered list stays in order through every Return, Backspace and paste.
   */
  const splice = useCallback(
    (from: number, to: number, insert: string, at?: number, coalesce = false, wasAt?: number): void => {
      const before = text.current
      const next = before.slice(0, from) + insert + before.slice(to)
      const settled = renumberAround(next, from, from + insert.length, at ?? from + insert.length)
      write(settled.text, settled.at, { text: before, caret: wasAt ?? from }, coalesce)
    },
    [write]
  )

  /** Where the selection is now, in characters, or null if it is not in here. */
  const where = useCallback((): Sel | null => {
    const el = root.current
    const sel = document.getSelection()
    if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return null
    const starts = lineStarts(text.current)
    const anchor = offsetOf(el, sel.anchorNode, sel.anchorOffset, starts)
    const focus = sel.focusNode ? offsetOf(el, sel.focusNode, sel.focusOffset, starts) : anchor
    return { anchor, focus }
  }, [])

  useImperativeHandle(ref, () => ({
    focus(at = 'end') {
      const pos = at === 'end' ? text.current.length : 0
      caret.current = { anchor: pos, focus: pos }
      root.current?.focus()
      redraw()
    }
  }))

  // Draws the document, then puts the caret back. Both have to happen in the same
  // frame: between replacing a line and restoring the cursor there is no cursor.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const lines = value.split('\n')
    const starts = lineStarts(value)

    // A value this editor did not write is another document — another note opened
    // from the palette — and its history must not be replayed into this one.
    if (value !== produced.current) {
      past.current = []
      future.current = []
      active.current = -1
      produced.current = value
      drawn.current = []
      if (document.activeElement === el) caret.current = { anchor: 0, focus: 0 }
    }

    // A note gained or renamed elsewhere changes which `[[links]]` resolve. Rare, and
    // a full redraw — with the selection carried across it, since nobody asked for it.
    const sig = targets.current.join('\n')
    if (sig !== targetSig.current) {
      targetSig.current = sig
      if (drawn.current.length) {
        drawn.current = []
        if (!caret.current) caret.current = where()
      }
    }

    const at = caret.current
    if (at) active.current = lineAt(starts, at.focus)

    const ctx = layout(lines)
    const keys = lines.map((line, i) => keyOf(line, ctx[i], i === active.current))
    reconcile(el, drawn.current, keys, (i) => draw(lines[i], ctx[i], i === active.current, i, targets.current))
    drawn.current = keys
    el.dataset.empty = value ? '' : '1'

    if (at) {
      settling.current = true
      put(el, at, starts)
      caret.current = null
      queueMicrotask(() => {
        settling.current = false
      })
      setSuggest((s) => suggestionAt(value, at, s))
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
      const sel = where()
      if (!sel) return
      setSuggest((s) => suggestionAt(text.current, sel, s))
      const line = lineAt(lineStarts(text.current), sel.focus)
      if (line === active.current) return
      active.current = line
      caret.current = sel
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
      let from = here ? Math.min(here.anchor, here.focus) : 0
      let to = here ? Math.max(here.anchor, here.focus) : 0
      const wasAt = here?.focus
      if (target) {
        from = offsetOf(el, target.startContainer, target.startOffset, starts)
        to = offsetOf(el, target.endContainer, target.endOffset, starts)
        if (from > to) [from, to] = [to, from]
      }
      e.preventDefault()

      switch (e.inputType) {
        case 'insertText':
          splice(from, to, e.data ?? '', undefined, from === to && (e.data ?? '') !== ' ', wasAt)
          return
        // A spelling correction, ⌃T, ⌃Y: the browser says what goes in the range.
        case 'insertReplacementText':
        case 'insertTranspose':
        case 'insertFromYank':
          splice(from, to, e.dataTransfer?.getData('text/plain') ?? e.data ?? '', undefined, false, wasAt)
          return
        // Chromium picks between the two by where in the block structure the caret
        // is — Return at the end of an empty list item comes through as a line break.
        // In Markdown a newline is a newline, so both take the same path.
        case 'insertParagraph':
        case 'insertLineBreak':
          enter(from, to, text.current, splice)
          return
        case 'insertFromPaste':
        case 'insertFromDrop':
          paste(from, to, e.dataTransfer, text.current, splice)
          return
        default:
          if (e.inputType.startsWith('delete')) {
            const backward = e.inputType === 'deleteContentBackward'
            if (from === to && from > 0) splice(from - 1, from, '', undefined, backward, wasAt)
            else splice(from, to, '', undefined, backward && to - from === 1, wasAt)
          }
      }
    }

    el.addEventListener('beforeinput', onBefore as EventListener)
    return () => el.removeEventListener('beforeinput', onBefore as EventListener)
  }, [splice, where])

  /** A picture, from a drop or the clipboard, written in where the caret is. */
  const takeImage = useCallback(
    async (file: File, at?: number): Promise<void> => {
      const handler = imageHandler.current
      if (!handler) return
      const result = await handler(file)
      if (!result) return
      const source = text.current
      const sel = where()
      const pos = at ?? (sel ? Math.max(sel.anchor, sel.focus) : source.length)
      const starts = lineStarts(source)
      const i = lineAt(starts, pos)
      const line = source.split('\n')[i]
      const md = `![${result.alt.replace(/[[\]|]/g, '')}](${result.url})`
      // On a line of its own: a picture in the middle of a sentence is a thumbnail.
      const insert = line.trim() ? (pos === starts[i] + line.length ? `\n${md}` : `\n${md}\n`) : md
      splice(pos, pos, insert)
    },
    [splice, where]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (composing.current) return
      const meta = e.metaKey || e.ctrlKey
      const sel = where()
      if (!sel) return
      const from = Math.min(sel.anchor, sel.focus)
      const to = Math.max(sel.anchor, sel.focus)
      const source = text.current

      if (suggest) {
        const matches = matching(targets.current, suggest.query)
        if (e.key === 'Escape') {
          e.preventDefault()
          setSuggest(null)
          return
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (matches.length) {
            const n = matches.length
            setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
          }
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) {
          e.preventDefault()
          e.stopPropagation()
          const pick = matches[Math.min(suggest.index, matches.length - 1)]
          // Whatever closing brackets are already there are taken over, not doubled.
          const closing = /^\]\]/.test(source.slice(to)) ? 2 : /^\]/.test(source.slice(to)) ? 1 : 0
          splice(suggest.from, to + closing, `[[${pick}]]`)
          setSuggest(null)
          return
        }
      }

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.stopPropagation()
        const stack = e.shiftKey ? future : past
        const other = e.shiftKey ? past : future
        const step = stack.current.pop()
        if (!step) return
        other.current.push({ text: source, caret: sel.focus })
        merged.current = 0
        write(step.text, step.caret)
        return
      }

      if (meta && e.altKey && /^Digit[1-6]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        toggleHeading(source, from, to, Number(e.code.slice(5)), write)
        return
      }

      if (meta && e.shiftKey && !e.altKey) {
        const list: Record<string, 'number' | 'bullet' | 'quote'> = {
          Digit7: 'number',
          Digit8: 'bullet',
          Digit9: 'quote'
        }
        const kind = list[e.code]
        if (kind) {
          e.preventDefault()
          e.stopPropagation()
          toggleBlock(source, from, to, kind, write)
          return
        }
        if (e.code === 'KeyX') {
          e.preventDefault()
          e.stopPropagation()
          wrap(source, from, to, '~~', splice)
          return
        }
      }

      if (meta && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase()
        const pair = key === 'b' ? '**' : key === 'i' ? '*' : key === 'e' ? '`' : ''
        if (pair) {
          e.preventDefault()
          e.stopPropagation()
          wrap(source, from, to, pair, splice)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          toggleBlock(source, from, to, 'task', write)
          return
        }
        if (e.key === '[' || e.key === ']') {
          e.preventDefault()
          e.stopPropagation()
          nudge(source, sel, e.key === ']' ? 1 : -1, write)
          return
        }
      }
      // ⌘K stays with the command palette; a link is one keystroke further along.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        const selected = source.slice(from, to)
        if (/^https?:\/\/\S+$/.test(selected)) splice(from, to, `[](${selected})`, from + 1)
        else splice(from, to, `[${selected}]()`, from + selected.length + 3)
        return
      }

      if (e.altKey && !meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        e.stopPropagation()
        moveBlock(source, sel, e.key === 'ArrowUp' ? -1 : 1, write)
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const lines = source.split('\n')
        const ctx = layout(lines)
        const i = lineAt(lineStarts(source), from)
        if (ctx[i].code) {
          if (!e.shiftKey) splice(from, to, INDENT)
          return
        }
        if (ctx[i].table && from === to) {
          hop(source, from, ctx[i].table, e.shiftKey ? -1 : 1, splice, write)
          return
        }
        nudge(source, sel, e.shiftKey ? -1 : 1, write)
        return
      }

      // Backspace where the words start takes the marker off rather than eating into
      // it: the way out of a list is to unmake the item, not to chew through `- `.
      // A nested item lifts a level first, the way Shift-Tab would.
      if (e.key === 'Backspace' && from === to) {
        const starts = lineStarts(source)
        const i = lineAt(starts, from)
        const lines = source.split('\n')
        const b = classify(lines[i], fenced(lines)[i])
        const edge = starts[i] + b.indent.length + b.marker.length
        // A `##` shows itself on this line and can be eaten one character at a time;
        // a bullet cannot be seen, so anywhere in it counts as its edge.
        const atEdge = b.structural ? from >= starts[i] && from <= edge : from === edge
        if (b.marker && atEdge) {
          e.preventDefault()
          e.stopPropagation()
          const indented = { anchor: from, focus: from }
          if (b.indent.length) nudge(source, indented, -1, write)
          else splice(starts[i], starts[i] + b.marker.length, '', starts[i], false, from)
        }
      }
    },
    [splice, suggest, where, write]
  )

  /*
   * The selection only ever holds what is on screen, and what is on screen is missing
   * every marker this editor hides. Copying has to take the Markdown instead.
   */
  const onClip = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
      const sel = where()
      if (!sel || sel.anchor === sel.focus) return
      e.preventDefault()
      let from = Math.min(sel.anchor, sel.focus)
      const to = Math.max(sel.anchor, sel.focus)
      // A selection that starts where the words start on an item started, as far as
      // anyone could see, at the bullet: the marker comes along.
      const source = text.current
      const starts = lineStarts(source)
      const i = lineAt(starts, from)
      const b = classify(source.split('\n')[i], false)
      if (b.structural && from === starts[i] + b.indent.length + b.marker.length) from = starts[i]
      e.clipboardData.setData('text/plain', source.slice(from, to))
      if (cut) splice(from, to, '')
    },
    [splice, where]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): void => {
      const image = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
      if (image && imageHandler.current) {
        e.preventDefault()
        void takeImage(image)
        return
      }
      const sel = where()
      if (!sel) return
      e.preventDefault()
      paste(Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus), e.clipboardData, text.current, splice)
    },
    [splice, takeImage, where]
  )

  /** Dragging an image's corner rewrites its `|width`. */
  const onResizeStart = useCallback(
    (e: React.MouseEvent, handle: HTMLElement): void => {
      e.preventDefault()
      const wrap = handle.parentElement as HTMLElement
      const img = wrap.querySelector('img') as HTMLImageElement | null
      const line = wrap.closest('.ln') as HTMLElement | null
      if (!img || !line) return
      const startX = e.clientX
      const startWidth = img.getBoundingClientRect().width
      const max = line.getBoundingClientRect().width
      let width = startWidth
      const move = (ev: MouseEvent): void => {
        width = Math.round(Math.min(max, Math.max(48, startWidth + ev.clientX - startX)))
        img.style.width = `${width}px`
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        const starts = lineStarts(text.current)
        const at = starts[Number(line.dataset.i)] + Number(wrap.dataset.from)
        const length = Number(wrap.dataset.len)
        const token = text.current.slice(at, at + length)
        const parts = /^!\[([^\]]*?)(?:\|\d+(?:x\d+)?)?\]\(([^)]*)\)$/.exec(token)
        if (!parts) return
        splice(at, at + length, `![${parts[1]}|${width}](${parts[2]})`, at)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [splice]
  )

  const matches = suggest ? matching(linkTargets, suggest.query) : []

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
        onPaste={onPaste}
        onDrop={(e) => {
          const image = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
          if (!image || !imageHandler.current) return
          e.preventDefault()
          const el = root.current
          const point = document.caretPositionFromPoint?.(e.clientX, e.clientY)
          const at =
            el && point && el.contains(point.offsetNode)
              ? offsetOf(el, point.offsetNode, point.offset, lineStarts(text.current))
              : undefined
          void takeImage(image, at)
        }}
        onBlur={() => setSuggest(null)}
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
          const sel = where()
          const before = text.current
          write(next, sel ? sel.focus : next.length, { text: before, caret: Math.min(before.length, sel?.focus ?? 0) })
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
          const handle = target.closest('[data-resize]') as HTMLElement | null
          if (handle) {
            onResizeStart(e, handle)
            return
          }
          const wiki = target.closest('[data-wiki]') as HTMLElement | null
          if (wiki && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onOpenLink?.(wiki.dataset.wiki as string)
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
      {suggest && matches.length > 0 && (
        <div
          className="mde-pop hairline absolute z-20 max-h-56 w-64 overflow-y-auto rounded-box border bg-base-100 py-1 shadow-lg"
          style={{ left: suggest.left, top: suggest.top }}
          // The editor must keep focus: a click here is a choice, not a departure.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((title, i) => (
            <button
              key={title}
              type="button"
              className={`block w-full truncate px-3 py-1.5 text-left text-[13px] ${
                i === Math.min(suggest.index, matches.length - 1) ? 'bg-base-content/8' : 'hover:bg-base-content/5'
              }`}
              onMouseEnter={() => setSuggest({ ...suggest, index: i })}
              onClick={() => {
                const source = text.current
                const sel = where()
                const to = sel ? Math.max(sel.anchor, sel.focus) : suggest.from + 2 + suggest.query.length
                const closing = /^\]\]/.test(source.slice(to)) ? 2 : /^\]/.test(source.slice(to)) ? 1 : 0
                splice(suggest.from, to + closing, `[[${title}]]`)
                setSuggest(null)
              }}
            >
              {title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface Sel {
  anchor: number
  focus: number
}

interface Snapshot {
  text: string
  caret: number
}

interface Suggest {
  /** Offset of the `[[`. */
  from: number
  query: string
  index: number
  left: number
  top: number
}

type Splice = (from: number, to: number, insert: string, at?: number, coalesce?: boolean, wasAt?: number) => void
type Write = (next: string, at: number | Sel, remember?: Snapshot, coalesce?: boolean) => void

/* ------------------------------------------------------------ completion */

/** The `[[` being typed on the caret's line, if there is one. */
function suggestionAt(source: string, sel: Sel, current: Suggest | null): Suggest | null {
  if (sel.anchor !== sel.focus) return null
  const starts = lineStarts(source)
  const i = lineAt(starts, sel.focus)
  const before = source.slice(starts[i], sel.focus)
  const m = /\[\[([^\]\n[|]*)$/.exec(before)
  if (!m) return null
  const from = starts[i] + m.index
  const query = m[1]
  if (current && current.from === from && current.query === query) return current

  // Under the caret, in the editor's own coordinates.
  const range = document.getSelection()?.getRangeAt(0)
  const rect = range?.getBoundingClientRect()
  const host = (range?.startContainer.parentElement?.closest('.mde')?.parentElement as HTMLElement | null)
    ?.getBoundingClientRect()
  const left = rect && host ? Math.max(0, rect.left - host.left) : 0
  const top = rect && host ? rect.bottom - host.top + 4 : 0
  return { from, query, index: current?.from === from ? current.index : 0, left, top }
}

function matching(targets: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const hits = targets.filter((t) => t.trim() && t.toLowerCase().includes(q))
  hits.sort((a, b) => {
    const sa = a.toLowerCase().startsWith(q) ? 0 : 1
    const sb = b.toLowerCase().startsWith(q) ? 0 : 1
    return sa - sb || a.localeCompare(b)
  })
  return hits.slice(0, 8)
}

/* ---------------------------------------------------------------- drawing */

/** Everything a line's drawing depends on, so an unchanged one is left alone. */
function keyOf(line: string, ctx: LineContext, on: boolean): string {
  const table = ctx.table ? `t${ctx.table.start}:${ctx.table.widths.join(',')}:${ctx.table.align.join(',')}` : ''
  const callout = ctx.callout ? `c${ctx.callout.type}${ctx.calloutHead ? 1 : 0}` : ''
  return `${ctx.code ? 1 : 0}|${on ? 1 : 0}|${table}|${callout}|${line}`
}

/**
 * Replaces only the lines whose drawing changed. Keyed by content rather than by
 * index, and diffed from both ends: Return near the top of a long note used to
 * shift every index below it and rebuild the whole document.
 */
function reconcile(el: HTMLElement, old: string[], next: string[], build: (i: number) => HTMLElement): void {
  if (el.children.length !== old.length || old.length === 0) {
    el.replaceChildren()
    old = []
  }
  let prefix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++

  for (let k = old.length - suffix - 1; k >= prefix; k--) el.removeChild(el.children[k])
  const before = el.children[prefix] ?? null
  for (let k = prefix; k < next.length - suffix; k++) el.insertBefore(build(k), before)
  for (let k = prefix; k < next.length; k++) (el.children[k] as HTMLElement).dataset.i = String(k)
}

function draw(raw: string, ctx: LineContext, on: boolean, index: number, targets: string[]): HTMLElement {
  if (ctx.table) return drawRow(raw, ctx.table, on, index)

  const b = classify(raw, ctx.code)
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

  const depth = depthOf(b.indent)
  const list = isListItem(b)
  if (depth || list) line.style.paddingLeft = `${depth * STEP + (list ? GUTTER : 0)}em`
  // The thread down from each item to what is nested under it.
  for (let d = 0; d < depth; d++) {
    const guide = figure('gd')
    guide.style.left = `${d * STEP + 0.3}em`
    line.append(guide)
  }
  if (b.indent) line.append(mark(b.indent, true))
  if (b.marker) {
    // A fence keeps its backticks: the language after them is worth seeing.
    const hide = b.kind === 'fence' ? false : b.structural || !on
    line.append(mark(b.marker, hide))
  }
  // The caret has no business inside a hidden marker; `offsetOf` snaps past it.
  if (b.structural) line.dataset.p = String(b.indent.length + b.marker.length)

  // The marker drawn as the thing it means. These carry no text of their own, so the
  // Markdown the document serialises back to is unaffected by them.
  const gutter = `${depth * STEP}em`
  if (b.kind === 'bullet') line.append(figure('bul', '', gutter))
  if (b.kind === 'number') line.append(figure('num', b.ordinal, gutter))
  if (b.kind === 'task') {
    const box = figure(b.checked ? 'box on' : 'box', '', gutter)
    box.dataset.task = '1'
    line.append(box)
  }

  let body = b.text
  let visible = b.text.length > 0 || (Boolean(b.marker) && !b.structural && on)

  if (ctx.callout) {
    line.dataset.callout = ctx.callout.type
    if (ctx.calloutHead) {
      line.dataset.head = '1'
      const head = /^(\[![a-zA-Z]+\][+-]?)(\s*)(.*)$/.exec(b.text)
      if (head) {
        line.append(mark(head[1] + head[2], !on))
        line.append(calloutIcon(ctx.callout.type))
        body = head[3]
        visible = true
      }
    }
  }

  let col = b.indent.length + b.marker.length + (b.text.length - body.length)
  for (const token of inlines(body)) {
    const length = token.open.length + token.body.length + token.close.length
    if (token.kind === 'text') {
      line.append(document.createTextNode(token.body))
      col += length
      continue
    }
    if (token.kind === 'image' && token.href.startsWith('neo-media://')) {
      line.append(mark(token.open + token.body + token.close, !on))
      line.append(picture(token.href, token.body, token.size, col, length))
      visible = true
      col += length
      continue
    }
    if (token.open) line.append(mark(token.open, !on))
    const el = document.createElement(TAG[token.kind])
    el.textContent = token.body
    if (token.kind === 'strong' && token.open === '***') el.style.fontStyle = 'italic'
    if (token.kind === 'link') {
      el.className = 'lk'
      el.dataset.href = token.href
      el.title = `${token.href} — ⌘-click to open`
    }
    if (token.kind === 'wiki') {
      const known = targets.some((t) => t.toLowerCase() === token.href.toLowerCase())
      el.className = known ? 'lk wk' : 'lk wk missing'
      el.dataset.wiki = token.href
      el.title = known ? `${token.href} — ⌘-click to open` : `${token.href} — no note with this name yet; ⌘-click to start one`
    }
    line.append(el)
    if (token.close) line.append(mark(token.close, !on))
    col += length
  }

  if (b.kind === 'task') visible = true
  if (!visible) {
    // Somewhere for the caret to land on a line whose every character is hidden.
    line.append(document.createTextNode(''))
    line.append(document.createElement('br'))
  }
  return line
}

/**
 * One row of a table, on the grid every row of that table shares. The pipes stay in
 * the text and out of sight; each cell is a grid item holding its own characters.
 */
function drawRow(raw: string, table: Table, on: boolean, index: number): HTMLElement {
  const line = document.createElement('div')
  line.className = 'ln'
  line.dataset.i = String(index)
  line.dataset.b = 'table'
  if (on) line.dataset.on = '1'
  const divider = index === table.start + 1
  if (index === table.start) line.dataset.head = '1'
  if (divider) line.dataset.div = '1'
  line.style.gridTemplateColumns = table.widths.map((w) => `minmax(0, ${Math.max(w, 3)}fr)`).join(' ')

  // Faithful to every character: what is not a cell is a hidden mark.
  const lead = /^\s*\|?/.exec(raw)![0]
  let at = lead.length
  if (lead) line.append(mark(lead, true))
  let column = 0
  while (at <= raw.length && column < table.widths.length) {
    const end = raw.indexOf('|', at)
    const stop = end === -1 ? raw.length : end
    const cellRaw = raw.slice(at, stop)
    const cell = document.createElement('span')
    cell.className = 'cell'
    cell.style.textAlign = table.align[column] ?? 'left'
    // The spaces around a cell's words stay visible text: they are what the caret
    // sits in when the cell is empty, and a hidden span cannot hold one.
    const ws = /^\s*/.exec(cellRaw)![0]
    const content = cellRaw.slice(ws.length).replace(/\s+$/, '')
    const trailing = cellRaw.slice(ws.length + content.length)
    if (ws) cell.append(document.createTextNode(ws))
    if (divider) cell.append(mark(content, !on))
    else if (content) {
      for (const token of inlines(content)) {
        if (token.kind === 'text') {
          cell.append(document.createTextNode(token.body))
          continue
        }
        if (token.open) cell.append(mark(token.open, !on))
        const el = document.createElement(TAG[token.kind] ?? 'span')
        el.textContent = token.body
        if (token.kind === 'link') {
          el.className = 'lk'
          el.dataset.href = token.href
        }
        cell.append(el)
        if (token.close) cell.append(mark(token.close, !on))
      }
    }
    if (trailing) cell.append(document.createTextNode(trailing))
    if (!ws && !trailing && (!content || (divider && !on))) cell.append(document.createTextNode(''))
    if (end !== -1) cell.append(mark('|', true))
    line.append(cell)
    column++
    at = stop + 1
    if (end === -1) break
  }
  if (at < raw.length) line.append(mark(raw.slice(at), true))
  return line
}

const TAG: Record<string, string> = {
  strong: 'b',
  em: 'i',
  code: 'code',
  strike: 's',
  link: 'span',
  wiki: 'span',
  image: 'span'
}

function mark(chars: string, hide: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mk'
  el.textContent = chars
  if (hide) el.dataset.h = '1'
  return el
}

/** Empty on purpose: it draws through CSS, so it contributes nothing to the text. */
function figure(className: string, ordinal = '', left = ''): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.contentEditable = 'false'
  if (ordinal) el.dataset.n = ordinal
  if (left) el.style.left = left
  return el
}

/** The picture itself, with a corner to drag. No text: the Markdown is in the mark. */
function picture(href: string, alt: string, size: string, from: number, length: number): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'pic'
  wrap.contentEditable = 'false'
  wrap.dataset.from = String(from)
  wrap.dataset.len = String(length)
  const img = document.createElement('img')
  img.src = href
  img.alt = alt
  img.draggable = false
  const [w, h] = size.split('x')
  if (w) img.style.width = `${w}px`
  if (h) img.style.height = `${h}px`
  wrap.append(img)
  const handle = document.createElement('span')
  handle.className = 'grab'
  handle.dataset.resize = '1'
  handle.title = 'Drag to resize'
  wrap.append(handle)
  return wrap
}

const CALLOUT_ICON: Record<CalloutType, IconName> = {
  note: 'note',
  abstract: 'journal',
  info: 'info',
  todo: 'checkbox',
  tip: 'sparkle',
  success: 'check',
  question: 'question',
  warning: 'alert',
  failure: 'close',
  danger: 'danger',
  bug: 'bug',
  example: 'board',
  quote: 'quote'
}

function calloutIcon(type: CalloutType): HTMLElement {
  const el = figure('ci')
  el.innerHTML =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath(CALLOUT_ICON[type])}"/></svg>`
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

function fenced(lines: string[]): boolean[] {
  return layout(lines).map((c) => c.code)
}

/** A position in the drawn document, as a position in the Markdown behind it. */
function offsetOf(root: HTMLElement, node: Node, offset: number, starts: number[]): number {
  const from = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const line = from?.closest('.ln') as HTMLElement | null
  if (!line) {
    // On the root itself, as ⌘A leaves it: before the nth line, or after the last.
    if (offset >= root.children.length) {
      const lastLine = root.children[root.children.length - 1] as HTMLElement | undefined
      return (starts[starts.length - 1] ?? 0) + (lastLine?.textContent?.length ?? 0)
    }
    return starts[Math.max(offset, 0)] ?? 0
  }
  const start = starts[Number(line.dataset.i)] ?? 0
  // Never inside a marker that is drawn as something else.
  const floor = Number(line.dataset.p ?? 0)

  let within = 0
  if (node.nodeType !== Node.TEXT_NODE) {
    const kids = node.childNodes
    for (let k = 0; k < offset && k < kids.length; k++) within += kids[k].textContent?.length ?? 0
  }

  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === node) return start + Math.max(floor, within + offset)
    if (node.nodeType !== Node.TEXT_NODE && node.contains(n)) break
    within += n.textContent?.length ?? 0
  }
  return start + Math.max(floor, within)
}

/** The inverse, skipping the markers that are currently drawn as nothing. */
function locate(root: HTMLElement, offset: number, starts: number[]): { node: Node; offset: number } | null {
  const i = lineAt(starts, offset)
  const line = root.children[i] as HTMLElement | undefined
  if (!line) return null
  const target = offset - starts[i]

  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let at = 0
  let after: { node: Node; offset: number } | null = null
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const length = n.textContent?.length ?? 0
    if (!(n.parentElement as HTMLElement | null)?.closest('[data-h]')) {
      if (at <= target && target <= at + length) return { node: n, offset: target - at }
      if (at > target && !after) after = { node: n, offset: 0 }
    }
    at += length
  }
  return after ?? { node: line, offset: 0 }
}

function put(root: HTMLElement, sel: Sel, starts: number[]): void {
  const a = locate(root, sel.anchor, starts)
  const f = sel.focus === sel.anchor ? a : locate(root, sel.focus, starts)
  if (!a || !f) return
  const selection = document.getSelection()
  if (!selection) return
  selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset)
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
  const ctx = layout(lines)

  // Return in a table is a new row under this one, not a line break through it.
  if (ctx[i].table && from === to) {
    const table = ctx[i].table
    const row = i === table.start ? table.start + 1 : i
    const end = starts[row] + lines[row].length
    const fresh = `|${table.widths.map(() => '  ').join('|')}|`
    splice(end, end, `\n${fresh}`, end + 1 + cellStarts(fresh)[0])
    return
  }

  const b = classify(lines[i], ctx[i].code)

  // Return on an item with nothing in it means you are finished with the list — or,
  // nested, that you are done with this level and back on the one above.
  if (from === to && b.marker && b.structural && !b.text.trim()) {
    if (b.indent.length) {
      const cut = b.indent.startsWith('\t') ? 1 : Math.min(INDENT.length, b.indent.length)
      splice(starts[i], starts[i] + cut, '', from - cut)
    } else splice(starts[i], starts[i] + b.marker.length, '', starts[i])
    return
  }

  splice(from, to, `\n${carry(b)}`)
}

/**
 * Pasting. A URL over a selection makes a link; several lines into a list item
 * stay a list; a page copied from a browser arrives as Markdown rather than as its
 * words alone.
 */
function paste(from: number, to: number, data: DataTransfer | null, source: string, splice: Splice): void {
  const plain = (data?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n')
  const html = data?.getData('text/html') ?? ''
  if (from !== to && /^https?:\/\/\S+$/.test(plain.trim())) {
    splice(from, to, `[${source.slice(from, to)}](${plain.trim()})`)
    return
  }
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const i = lineAt(starts, from)
  const ctx = layout(lines)

  let text = plain
  if (!ctx[i].code && html) text = htmlToMarkdown(html) ?? plain

  // Lines pasted into an item become items, unless they already are.
  const b = classify(lines[i], ctx[i].code)
  if (isListItem(b) && text.includes('\n') && !/^\s*(?:[-*+]|\d+[.)])\s/m.test(text)) {
    const prefix = carry(b)
    text = text
      .split('\n')
      .map((l, k) => (k === 0 || !l.trim() ? l : prefix + l))
      .join('\n')
  }
  splice(from, to, text)
}

function wrap(source: string, from: number, to: number, pair: string, splice: Splice): void {
  const n = pair.length
  if (from === to) {
    // Nothing selected: the word under the caret, if there is one.
    const word = wordAt(source, from)
    if (word) {
      const [a, b] = word
      if (source.slice(a - n, a) === pair && source.slice(b, b + n) === pair) {
        splice(a - n, b + n, source.slice(a, b), from - n)
      } else splice(a, b, pair + source.slice(a, b) + pair, from + n)
      return
    }
  }
  const selected = source.slice(from, to)
  if (source.slice(from - n, from) === pair && source.slice(to, to + n) === pair) {
    splice(from - n, to + n, selected, from - n)
    return
  }
  if (selected.length > n * 2 && selected.startsWith(pair) && selected.endsWith(pair)) {
    splice(from, to, selected.slice(n, -n), from)
    return
  }
  if (selected.includes('\n')) {
    // Across lines, each line wears its own pair: emphasis does not span a newline.
    const wrapped = selected
      .split('\n')
      .map((l) => (l.trim() ? pair + l + pair : l))
      .join('\n')
    splice(from, to, wrapped, from + wrapped.length)
    return
  }
  splice(from, to, pair + selected + pair, from + n)
}

const WORD = /[\p{L}\p{N}_'’-]/u

function wordAt(source: string, at: number): [number, number] | null {
  let a = at
  let b = at
  while (a > 0 && WORD.test(source[a - 1])) a--
  while (b < source.length && WORD.test(source[b])) b++
  return b > a ? [a, b] : null
}

/** The lines a selection touches, first and last inclusive. */
function span(source: string, sel: Sel): { starts: number[]; lines: string[]; first: number; last: number } {
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const from = Math.min(sel.anchor, sel.focus)
  let to = Math.max(sel.anchor, sel.focus)
  // A selection ending exactly at a line's start does not include that line.
  const first = lineAt(starts, from)
  let last = lineAt(starts, to)
  if (last > first && starts[last] === to) {
    last--
    to--
  }
  return { starts, lines, first, last }
}

/**
 * Shifts each end of a selection by what changed on the lines before it. A change
 * on the caret's own line is always at its start — a marker, an ordinal, an indent
 * — so it moves the caret too, but never back past where the line begins.
 */
function shifted(sel: Sel, starts: number[], deltas: Map<number, number>): Sel {
  const move = (offset: number): number => {
    const i = lineAt(starts, offset)
    let before = 0
    let own = 0
    for (const [k, d] of deltas) {
      if (k < i) before += d
      else if (k === i) own += d
    }
    return Math.max(0, Math.max(starts[i] + before, offset + before + own))
  }
  return { anchor: move(sel.anchor), focus: move(sel.focus) }
}

/** Tab nests, Shift-Tab lifts, across every line the selection touches. */
function nudge(source: string, sel: Sel, direction: 1 | -1, write: Write): void {
  const { starts, lines, first, last } = span(source, sel)
  if (direction === 1 && !mayIndent(lines, first)) return
  const deltas = new Map<number, number>()

  for (let i = first; i <= last; i++) {
    if (!lines[i].trim() && first !== last) continue
    if (direction === 1) {
      lines[i] = INDENT + lines[i]
      deltas.set(i, INDENT.length)
    } else {
      const cut = lines[i].startsWith('\t') ? 1 : lines[i].startsWith(INDENT) ? INDENT.length : lines[i].startsWith(' ') ? 1 : 0
      if (!cut) continue
      lines[i] = lines[i].slice(cut)
      deltas.set(i, -cut)
    }
  }
  if (!deltas.size) return
  const moved = shifted(sel, starts, deltas)
  const settled = renumberLines(lines, first - 1, last + 1, moved)
  write(settled.text, settled.sel, { text: source, caret: sel.focus })
}

/**
 * Nesting has to be under something. An item may go one level deeper than the item
 * above it; the first item of a list, and a paragraph with no list over it, stay put.
 */
function mayIndent(lines: string[], i: number): boolean {
  const here = classify(lines[i], false)
  let k = i - 1
  while (k >= 0 && !lines[k].trim()) k--
  if (k < 0) return false
  const above = classify(lines[k], false)
  const room = depthOf(above.indent) + (isListItem(above) ? 1 : 0)
  return depthOf(here.indent) + 1 <= room
}

/** The line and everything nested under it, as a range of line indices. */
function blockOf(lines: string[], i: number): [number, number] {
  const b = classify(lines[i], false)
  if (!isListItem(b)) return [i, i + 1]
  const depth = depthOf(b.indent)
  let end = i + 1
  while (end < lines.length && lines[end].trim() && depthOf(/^\s*/.exec(lines[end])![0]) > depth) end++
  return [i, end]
}

/**
 * ⌥↑ / ⌥↓: the selected lines swap places with the block beside them. A single
 * list item travels with everything nested under it, and steps over a neighbour's
 * nested lines rather than into them.
 */
function moveBlock(source: string, sel: Sel, direction: 1 | -1, write: Write): void {
  const { lines, first, last } = span(source, sel)
  const [top, bottom] = first === last ? blockOf(lines, first) : [first, last + 1]
  let swapStart: number
  let swapEnd: number
  if (direction === -1) {
    if (top === 0) return
    swapEnd = top
    swapStart = top - 1
    if (isListItem(classify(lines[top], false))) {
      const depth = depthOf(/^\s*/.exec(lines[top])![0])
      while (
        swapStart > 0 &&
        lines[swapStart].trim() &&
        depthOf(/^\s*/.exec(lines[swapStart])![0]) > depth
      ) swapStart--
    }
  } else {
    if (bottom >= lines.length) return
    ;[swapStart, swapEnd] = blockOf(lines, bottom)
  }
  const moving = lines.slice(top, bottom)
  const other = lines.slice(swapStart, swapEnd)
  const next = direction === -1
    ? [...lines.slice(0, swapStart), ...moving, ...other, ...lines.slice(bottom)]
    : [...lines.slice(0, top), ...other, ...moving, ...lines.slice(swapEnd)]
  const shift = (other.join('\n').length + 1) * direction
  const moved = { anchor: sel.anchor + shift, focus: sel.focus + shift }
  const settled = renumberLines(next, Math.min(top, swapStart) - 1, Math.max(bottom, swapEnd) + 1, moved)
  write(settled.text, settled.sel, { text: source, caret: sel.focus })
}

/**
 * ⌘⇧7 / ⌘⇧8 / ⌘⇧9 / ⌘⏎: every selected line becomes that kind of line, or stops
 * being one if they all already are. A task on a task toggles its box.
 */
function toggleBlock(source: string, from: number, to: number, kind: 'number' | 'bullet' | 'quote' | 'task', write: Write): void {
  const sel = { anchor: from, focus: to }
  const { starts, lines, first, last } = span(source, sel)
  const blocks = lines.slice(first, last + 1).map((l) => classify(l, false))
  const all = blocks.every((b) => b.kind === kind || (!b.text.trim() && !b.marker && blocks.length > 1))
  const deltas = new Map<number, number>()
  let n = 0

  for (let i = first; i <= last; i++) {
    const b = blocks[i - first]
    if (!lines[i].trim() && first !== last) continue
    const before = lines[i].length
    if (kind === 'task' && b.kind === 'task') {
      const box = b.indent.length + b.marker.indexOf('[') + 1
      lines[i] = lines[i].slice(0, box) + (b.checked ? ' ' : 'x') + lines[i].slice(box + 1)
      continue
    }
    if (all) {
      lines[i] = b.indent + b.text
    } else {
      const marker =
        kind === 'bullet' ? '- ' :
        kind === 'task' ? (b.kind === 'number' ? `${b.ordinal} [ ] ` : '- [ ] ') :
        kind === 'quote' ? '> ' :
        `${++n}. `
      lines[i] = b.indent + marker + b.text
    }
    deltas.set(i, lines[i].length - before)
  }
  const moved = shifted(sel, starts, deltas)
  const settled = renumberLines(lines, first - 1, last + 1, moved)
  write(settled.text, settled.sel, { text: source, caret: to })
}

/** ⌘⌥1–6: the heading level of every selected line, off again at the same level. */
function toggleHeading(source: string, from: number, to: number, level: number, write: Write): void {
  const sel = { anchor: from, focus: to }
  const { starts, lines, first, last } = span(source, sel)
  const deltas = new Map<number, number>()
  for (let i = first; i <= last; i++) {
    const b = classify(lines[i], false)
    const before = lines[i].length
    const text = b.kind.startsWith('h') && b.kind.length === 2 ? b.text : lines[i].slice(b.indent.length)
    lines[i] = b.kind === `h${level}` ? b.indent + b.text : `${b.indent}${'#'.repeat(level)} ${text}`
    deltas.set(i, lines[i].length - before)
  }
  write(lines.join('\n'), shifted(sel, starts, deltas), { text: source, caret: to })
}

/** Tab inside a table: the next cell, or a new row after the last one. */
function hop(source: string, at: number, table: Table, direction: 1 | -1, splice: Splice, write: Write): void {
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const i = lineAt(starts, at)
  const col = at - starts[i]
  const stops = cellStarts(lines[i])
  const k = stops.filter((s) => s <= col).length - 1
  const next = k + direction
  if (next >= 0 && next < stops.length) {
    write(source, starts[i] + stops[next])
    return
  }
  let row = i + direction
  if (row === table.start + 1) row += direction
  if (row >= table.start && row < table.end) {
    const there = cellStarts(lines[row])
    write(source, starts[row] + (direction === 1 ? there[0] : there[there.length - 1]))
    return
  }
  if (direction === -1) return
  const end = starts[table.end - 1] + lines[table.end - 1].length
  const fresh = `|${table.widths.map(() => '  ').join('|')}|`
  splice(end, end, `\n${fresh}`, end + 1 + cellStarts(fresh)[0])
}

/** Where each cell's content begins in a row, as columns. */
function cellStarts(raw: string): number[] {
  const out: number[] = []
  let at = /^\s*\|?/.exec(raw)![0].length
  while (at <= raw.length) {
    const end = raw.indexOf('|', at)
    const stop = end === -1 ? raw.length : end
    const ws = /^\s*/.exec(raw.slice(at, stop))![0].length
    out.push(at + ws)
    if (end === -1) break
    at = stop + 1
    if (at >= raw.length) break
  }
  return out
}

function toggle(source: string, index: number, splice: Splice): void {
  const starts = lineStarts(source)
  const lines = source.split('\n')
  const b = classify(lines[index], false)
  if (b.kind !== 'task') return
  const box = starts[index] + b.indent.length + b.marker.indexOf('[') + 1
  splice(box, box + 1, b.checked ? ' ' : 'x', box + 1)
}

/* ---------------------------------------------------------- numbered lists */

/**
 * Renumbers the ordered lists the lines `from`–`to` are part of, and only those:
 * a run is a set of numbered items at one depth, broken by a blank line or by a
 * line at that depth that is not one of them. The first item keeps its number, so
 * a list that starts at 4 still does.
 */
function renumberLines(lines: string[], from: number, to: number, sel: Sel): { text: string; sel: Sel } {
  const starts = lineStarts(lines.join('\n'))
  const deltas = new Map<number, number>()
  const done = new Set<number>()

  for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) {
    if (done.has(i)) continue
    const b = classify(lines[i], false)
    if (b.kind !== 'number') continue
    const depth = depthOf(b.indent)
    const run = runOf(lines, i, depth)
    // A nested list counts from one under its parent, however its lines got there.
    // A top-level one keeps its lowest number, so a list that starts at 4 still does
    // and two items that swapped places do not carry their numbers with them.
    let n = depth > 0
      ? 1
      : Math.min(...run.map((k) => Number(classify(lines[k], false).ordinal.slice(0, -1))))
    for (const k of run) {
      done.add(k)
      const item = classify(lines[k], false)
      const want = `${n}${item.ordinal.slice(-1)}`
      if (item.ordinal !== want) {
        const before = lines[k].length
        lines[k] = item.indent + want + lines[k].slice(item.indent.length + item.ordinal.length)
        deltas.set(k, lines[k].length - before)
      }
      n++
    }
  }
  const text = lines.join('\n')
  if (!deltas.size) return { text, sel }
  return { text, sel: shifted(sel, starts, deltas) }
}

function runOf(lines: string[], i: number, depth: number): number[] {
  const belongs = (k: number): 'item' | 'nested' | 'stop' => {
    if (!lines[k].trim()) return 'stop'
    const b = classify(lines[k], false)
    const d = depthOf(b.indent)
    if (d > depth) return 'nested'
    if (d < depth) return 'stop'
    return b.kind === 'number' ? 'item' : 'stop'
  }
  let top = i
  for (let k = i - 1; k >= 0; k--) {
    const what = belongs(k)
    if (what === 'stop') break
    if (what === 'item') top = k
  }
  const run: number[] = []
  for (let k = top; k < lines.length; k++) {
    const what = belongs(k)
    if (what === 'stop') break
    if (what === 'item') run.push(k)
  }
  return run
}

/** The lines an edit between `from` and `to` could have changed the numbering of. */
function renumberAround(text: string, from: number, to: number, at: number): { text: string; at: number } {
  const starts = lineStarts(text)
  const lines = text.split('\n')
  const first = lineAt(starts, from) - 1
  const last = lineAt(starts, to) + 1
  const settled = renumberLines(lines, first, last, { anchor: at, focus: at })
  return { text: settled.text, at: settled.sel.focus }
}

/* ------------------------------------------------------ pasted HTML → Markdown */

/**
 * What a browser puts on the clipboard, as Markdown. Only the shapes a note has a
 * word for; a page with none of them — a code editor's coloured spans, say — is
 * left to its plain text, which is the better copy of it.
 */
function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc.body.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,li,a[href],strong,b,em,i,code,pre,blockquote,hr,table,s,del')) {
    return null
  }
  const out = render(doc.body, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return out || null
}

function render(node: Node, indent: string): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = (): string => [...el.childNodes].map((n) => render(n, indent)).join('')
  const style = el.getAttribute('style') ?? ''

  switch (tag) {
    case 'script':
    case 'style':
    case 'head':
      return ''
    case 'br':
      return '\n'
    case 'hr':
      return '\n\n---\n\n'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`
    case 'p':
    case 'div':
    case 'section':
    case 'article':
      return `\n\n${inner().trim()}\n\n`
    case 'strong':
    case 'b': {
      const body = inner().trim()
      return !body || /font-weight:\s*(normal|400)/.test(style) ? inner() : `**${body}**`
    }
    case 'em':
    case 'i': {
      const body = inner().trim()
      return body ? `*${body}*` : ''
    }
    case 's':
    case 'del': {
      const body = inner().trim()
      return body ? `~~${body}~~` : ''
    }
    case 'code':
      return el.closest('pre') ? el.textContent ?? '' : `\`${el.textContent ?? ''}\``
    case 'pre':
      return `\n\n\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      const body = inner().trim() || href
      return /^https?:/.test(href) ? `[${body}](${href})` : body
    }
    case 'img':
      return el.getAttribute('alt') ?? ''
    case 'blockquote':
      return `\n\n${inner().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`
    case 'ul':
    case 'ol': {
      let n = Number(el.getAttribute('start') ?? 1)
      const items = [...el.children]
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li) => {
          const marker = tag === 'ol' ? `${n++}. ` : '- '
          const inline: string[] = []
          const nested: string[] = []
          for (const child of li.childNodes) {
            const t = (child as HTMLElement).tagName?.toLowerCase()
            if (t === 'ul' || t === 'ol') nested.push(render(child, indent + INDENT))
            else inline.push(render(child, indent))
          }
          const head = inline.join('').replace(/\n+/g, ' ').trim()
          return `${indent}${marker}${head}${nested.map((s) => `\n${s.replace(/^\n+|\n+$/g, '')}`).join('')}`
        })
      return `\n${items.join('\n')}\n`
    }
    case 'table': {
      const rows = [...el.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((cell) => render(cell, indent).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim())
      )
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]): string => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
      return `\n\n${line(rows[0])}\n|${Array(width).fill(' --- ').join('|')}|\n${rows.slice(1).map(line).join('\n')}\n\n`
    }
    default:
      return inner()
  }
}
