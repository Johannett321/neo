/**
 * Everything this app knows about Markdown syntax, in one place.
 *
 * A note *is* Markdown — it is stored as Markdown and mirrored to `~/.neo`
 * as Markdown — and the editor renders it in place as you type rather than beside
 * what you type. So this does not produce HTML: it says what each line is and where
 * the syntax ends and the words begin, and `MarkdownEditor` styles the line to match
 * while leaving the characters exactly where they are.
 *
 * Hand-rolled for the same reason the icons are: it is a bounded problem, and the
 * alternative is a parser and an editor framework carried around for one screen.
 */

export type BlockKind =
  | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'bullet' | 'number' | 'task' | 'quote' | 'rule' | 'fence' | 'code'

export interface Block {
  kind: BlockKind
  /** Leading whitespace: nesting, which becomes indentation rather than characters. */
  indent: string
  /** The syntax characters, trailing space included. Never rewritten, only styled. */
  marker: string
  /** Where the words start. */
  text: string
  /** '1.' for an ordered item, so the number can be drawn back in. */
  ordinal: string
  checked: boolean
  /**
   * Whether the marker is replaced by the styling rather than dressed up by it. A
   * bullet, a number and a checkbox *are* the marker drawn properly, so the characters
   * stay hidden even under the cursor; a `##` is a heading wearing its own syntax, and
   * shows itself on the line you are working on so you can edit it.
   */
  structural: boolean
}

const HEADING = /^(#{1,6})(\s+)(.*)$/
const BULLET = /^([-*+])(\s+)(.*)$/
const NUMBER = /^(\d{1,9}[.)])(\s+)(.*)$/
const TASK = /^(\[[ xX]\])(\s+)(.*)$/
const QUOTE = /^(>)(\s?)(.*)$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/
const FENCE = /^(?:```|~~~)/

const block = (kind: BlockKind, indent: string, marker: string, text: string, extra?: Partial<Block>): Block => ({
  kind,
  indent,
  marker,
  text,
  ordinal: '',
  checked: false,
  structural: false,
  ...extra
})

/** What one line is. `inCode` is true for lines inside a fence, which are literal. */
export function classify(raw: string, inCode: boolean): Block {
  if (inCode) return block('code', '', '', raw)

  const indent = /^\s*/.exec(raw)![0]
  const line = raw.slice(indent.length)

  if (FENCE.test(line)) return block('fence', indent, line, '')
  // Not structural: the dashes show on the line you are on, so a rule can be edited
  // rather than only appended to, and `***` half-way through `***bold***` is visible.
  if (RULE.test(line)) return block('rule', indent, line, '')

  const heading = HEADING.exec(line)
  if (heading) {
    const level = Math.min(6, heading[1].length)
    return block(`h${level}` as BlockKind, indent, heading[1] + heading[2], heading[3])
  }

  const bullet = BULLET.exec(line)
  if (bullet) {
    const task = TASK.exec(bullet[3])
    if (task) {
      return block('task', indent, bullet[1] + bullet[2] + task[1] + task[2], task[3], {
        structural: true,
        checked: task[1][1].toLowerCase() === 'x'
      })
    }
    return block('bullet', indent, bullet[1] + bullet[2], bullet[3], { structural: true })
  }

  const number = NUMBER.exec(line)
  if (number) {
    return block('number', indent, number[1] + number[2], number[3], {
      structural: true,
      ordinal: number[1]
    })
  }

  const quote = QUOTE.exec(line)
  if (quote) return block('quote', indent, quote[1] + quote[2], quote[3], { structural: true })

  return block('p', indent, '', line)
}

export const isListItem = (b: Block): boolean => b.kind === 'bullet' || b.kind === 'number' || b.kind === 'task'

/**
 * How deep a line is nested. Two spaces is one level, and so is a tab — a note
 * written elsewhere and pasted in is more often tab-indented than not.
 */
export function depthOf(indent: string): number {
  let depth = 0
  let spaces = 0
  for (const ch of indent) {
    if (ch === '\t') {
      depth += 1
      spaces = 0
    } else if (++spaces === 2) {
      depth += 1
      spaces = 0
    }
  }
  return depth
}

/** Which lines are inside a fence. The fence lines themselves are not. */
export function fenced(lines: string[]): boolean[] {
  const out: boolean[] = []
  let open = false
  for (const line of lines) {
    if (FENCE.test(line.trimStart())) {
      out.push(false)
      open = !open
    } else out.push(open)
  }
  return out
}

/* ------------------------------------------------------------------ callouts */

/**
 * A callout is a quote that says what kind of quote it is: `> [!warning] Title` on
 * the first line, the body on the `> ` lines under it. Obsidian's syntax, so a note
 * mirrored to disk reads there exactly as it does here. The vocabulary is closed on
 * purpose — a type nobody recognises falls back to `note` rather than to nothing.
 */
export const CALLOUT_TYPES = [
  'note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning',
  'failure', 'danger', 'bug', 'example', 'quote'
] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

const CALLOUT_ALIAS: Record<string, CalloutType> = {
  summary: 'abstract', tldr: 'abstract',
  hint: 'tip', important: 'tip',
  check: 'success', done: 'success',
  help: 'question', faq: 'question',
  caution: 'warning', attention: 'warning',
  fail: 'failure', missing: 'failure',
  error: 'danger',
  cite: 'quote'
}

const CALLOUT = /^\[!([a-zA-Z]+)\]([+-]?)(?:\s+(.*))?$/

export interface Callout {
  type: CalloutType
  /** The word as typed, so the editor can leave it where it is. */
  typed: string
  title: string
  /** `+` open, `-` closed, '' neither. Only the read-only renderer folds. */
  fold: '' | '+' | '-'
}

/** The callout a quote line opens, if it opens one. */
export function calloutOf(text: string): Callout | null {
  const m = CALLOUT.exec(text)
  if (!m) return null
  const word = m[1].toLowerCase()
  const type = (CALLOUT_TYPES as readonly string[]).includes(word)
    ? (word as CalloutType)
    : CALLOUT_ALIAS[word] ?? 'note'
  return { type, typed: m[1], title: m[3] ?? '', fold: m[2] as Callout['fold'] }
}

/* -------------------------------------------------------------------- tables */

export interface Table {
  /** First line of the table, the header row. */
  start: number
  /** One past the last row. */
  end: number
  /** Per column: 'left' | 'center' | 'right'. */
  align: string[]
  /** Widest cell per column, in characters, so every row can draw the same grid. */
  widths: number[]
}

/** A row of pipes, split into cells, with the outer pipes discarded. */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

export const isTableDivider = (line: string): boolean =>
  /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')

/**
 * A table is a header row, a divider, and the rows that follow until a line
 * without a pipe. Both renderers read this, and the editor uses `widths` to draw
 * every row of one table on the same grid — rows are separate lines in the
 * editor, so the columns have to be agreed on ahead of drawing.
 */
export function tableAt(lines: string[], start: number, inCode?: boolean[]): Table | null {
  const header = lines[start]
  const divider = lines[start + 1]
  if (inCode?.[start] || !header?.includes('|') || !divider || !isTableDivider(divider)) return null

  const columns = cells(header)
  const align = cells(divider).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'
  )
  if (columns.length < 2 || align.length !== columns.length) return null

  const widths = columns.map((c) => c.length)
  let end = start + 2
  while (end < lines.length && lines[end].includes('|') && lines[end].trim() && !inCode?.[end]) {
    cells(lines[end]).forEach((c, x) => {
      if (x < widths.length) widths[x] = Math.max(widths[x], c.length)
    })
    end++
  }
  return { start, end, align, widths }
}

/* -------------------------------------------------------------------- layout */

/**
 * What surrounds each line: whether it is inside a fence, which table it is a row
 * of, and which callout it is the body of. `classify` looks at one line at a time
 * and these are the three things that cannot be known from one line.
 */
export interface LineContext {
  code: boolean
  table: Table | null
  /** The callout this quote line belongs to, on every line of it including the first. */
  callout: Callout | null
  /** True on the line that opens the callout. */
  calloutHead: boolean
}

export function layout(lines: string[]): LineContext[] {
  const code = fenced(lines)
  const out: LineContext[] = lines.map((_, i) => ({ code: code[i], table: null, callout: null, calloutHead: false }))

  let i = 0
  while (i < lines.length) {
    if (code[i]) {
      i++
      continue
    }
    const table = tableAt(lines, i, code)
    if (table) {
      for (let k = table.start; k < table.end; k++) out[k].table = table
      i = table.end
      continue
    }
    const b = classify(lines[i], false)
    if (b.kind === 'quote') {
      const callout = calloutOf(b.text)
      if (callout) {
        out[i].callout = callout
        out[i].calloutHead = true
        i++
        while (i < lines.length && !code[i] && classify(lines[i], false).kind === 'quote') {
          out[i].callout = callout
          i++
        }
        continue
      }
    }
    i++
  }
  return out
}

/* ------------------------------------------------------------------- inlines */

export interface Inline {
  kind: 'text' | 'strong' | 'em' | 'code' | 'strike' | 'link' | 'image' | 'wiki'
  /** The opening syntax, which hides when the cursor is elsewhere. */
  open: string
  body: string
  close: string
  href: string
  /** An image's `|300` or `|300x200`, taken off the alt text. */
  size: string
}

/*
 * Built fresh per call rather than shared: a sticky `lastIndex` on one regex would
 * send the next line's scan off to wherever the last one finished.
 */
const INLINE = [
  '(?<code>`[^`\\n]+`)',
  '(?<both>\\*\\*\\*[^\\s*][^\\n]*?\\*\\*\\*)',
  '(?<strong>\\*\\*[^\\n]+?\\*\\*|__[^\\n]+?__)',
  '(?<strike>~~[^\\n]+?~~)',
  '(?<em>\\*[^\\s*][^\\n]*?\\*|_[^\\s_][^\\n]*?_)',
  // Before the link, and it has to be: a link pattern would match the `[…](…)` half
  // of an image and leave a stray `!` behind as text.
  '(?<image>!\\[[^\\]\\n]*\\]\\([^)\\s]*\\))',
  // Before the link too: `[[` would otherwise be read as a `[` that never closes.
  '(?<wiki>\\[\\[[^\\]\\n|]+(?:\\|[^\\]\\n]*)?\\]\\])',
  '(?<link>\\[[^\\]\\n]*\\]\\([^)\\s]*\\))',
  '(?<url>https?:\\/\\/[^\\s<>)\\]]+)'
].join('|')

const text = (body: string): Inline => ({ kind: 'text', open: '', body, close: '', href: '', size: '' })

/** An underscore only opens emphasis from a word boundary: snake_case is not italic. */
const insideWord = (source: string, from: number, to: number): boolean =>
  /\w/.test(source[from - 1] ?? '') || /\w/.test(source[to] ?? '')

/** One level deep: bold inside a link is not worth the machinery it would take. */
export function inlines(source: string): Inline[] {
  const out: Inline[] = []
  const scan = new RegExp(INLINE, 'g')
  let last = 0

  for (let m = scan.exec(source); m; m = scan.exec(source)) {
    const g = m.groups as Record<string, string | undefined>
    const end = m.index + m[0].length
    if (g.em && g.em.startsWith('_') && insideWord(source, m.index, end)) continue
    if (g.strong && g.strong.startsWith('__') && insideWord(source, m.index, end)) continue

    let token: Inline | null = null
    let length = m[0].length

    if (g.code) token = { kind: 'code', open: '`', body: g.code.slice(1, -1), close: '`', href: '', size: '' }
    else if (g.both) token = { kind: 'strong', open: '***', body: g.both.slice(3, -3), close: '***', href: '', size: '' }
    else if (g.strong) {
      const mark = g.strong.slice(0, 2)
      token = { kind: 'strong', open: mark, body: g.strong.slice(2, -2), close: mark, href: '', size: '' }
    } else if (g.strike) token = { kind: 'strike', open: '~~', body: g.strike.slice(2, -2), close: '~~', href: '', size: '' }
    else if (g.em) {
      const mark = g.em.slice(0, 1)
      token = { kind: 'em', open: mark, body: g.em.slice(1, -1), close: mark, href: '', size: '' }
    } else if (g.image) {
      const parts = /^!\[([^\]]*)\]\(([^)\s]*)\)$/.exec(g.image)
      if (parts) {
        // `body` is the alt text, which is what the editor shows and what the
        // renderer draws underneath the picture. `|300` after it is the width, the
        // way Obsidian writes one, so a resized picture is still one elsewhere.
        const sized = /^(.*?)\|(\d+(?:x\d+)?)$/.exec(parts[1])
        token = {
          kind: 'image',
          open: '![',
          body: sized ? sized[1] : parts[1],
          close: `${sized ? `|${sized[2]}` : ''}](${parts[2]})`,
          href: parts[2],
          size: sized ? sized[2] : ''
        }
      }
    } else if (g.wiki) {
      const parts = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(g.wiki)
      if (parts) {
        const target = parts[1].trim()
        // The alias, when there is one, is the body; the target then rides in the
        // opening syntax so the editor shows it only on the line being edited.
        token = parts[2] !== undefined
          ? { kind: 'wiki', open: `[[${parts[1]}|`, body: parts[2], close: ']]', href: target, size: '' }
          : { kind: 'wiki', open: '[[', body: parts[1], close: ']]', href: target, size: '' }
      }
    } else if (g.link) {
      const parts = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(g.link)
      // The label and only the label: putting the URL in as a stand-in would draw
      // characters that are not in the text, and the caret arithmetic counts them.
      if (parts) token = { kind: 'link', open: '[', body: parts[1], close: `](${parts[2]})`, href: parts[2], size: '' }
    } else if (g.url) {
      // A full stop after a URL belongs to the sentence, not to the address.
      const trimmed = g.url.replace(/[.,;:!?]+$/, '')
      length = trimmed.length
      token = { kind: 'link', open: '', body: trimmed, close: '', href: trimmed, size: '' }
    }

    if (!token) continue
    if (m.index > last) out.push(text(source.slice(last, m.index)))
    out.push(token)
    last = m.index + length
    scan.lastIndex = last
  }

  if (last < source.length) out.push(text(source.slice(last)))
  return out
}

/** Every `[[target]]` in a note, for backlinks. Case is not significant. */
export function wikiTargets(source: string): string[] {
  const out: string[] = []
  const scan = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
  for (let m = scan.exec(source); m; m = scan.exec(source)) out.push(m[1].trim())
  return out
}

/**
 * The same note reduced to its words, for the two lines of preview a list row has.
 * The marks come off and the words stay.
 */
export function excerpt(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?(?:\[![a-zA-Z]+\][+-]?\s*)?/gm, '')
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '$1')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, '')
    .replace(/!\[([^\]\n]*?)(?:\|\d+(?:x\d+)?)?\]\([^)\s]*\)/g, '$1')
    .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_, target: string, alias?: string) => alias || target)
    .replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_, label: string, href: string) => label || href)
    .replace(/(\*\*|__|~~|[*_`|])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
