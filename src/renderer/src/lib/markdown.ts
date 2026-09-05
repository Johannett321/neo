/**
 * Everything this app knows about Markdown syntax, in one place.
 *
 * A note *is* Markdown — it is stored as Markdown and mirrored to `~/Documents/Neo`
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
  if (RULE.test(line)) return block('rule', indent, line, '', { structural: true })

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

export interface Inline {
  kind: 'text' | 'strong' | 'em' | 'code' | 'strike' | 'link'
  /** The opening syntax, which hides when the cursor is elsewhere. */
  open: string
  body: string
  close: string
  href: string
}

/*
 * Built fresh per call rather than shared: a sticky `lastIndex` on one regex would
 * send the next line's scan off to wherever the last one finished.
 */
const INLINE = [
  '(?<code>`[^`\\n]+`)',
  '(?<strong>\\*\\*[^\\n]+?\\*\\*|__[^\\n]+?__)',
  '(?<strike>~~[^\\n]+?~~)',
  '(?<em>\\*[^\\s*][^\\n]*?\\*|_[^\\s_][^\\n]*?_)',
  '(?<link>\\[[^\\]\\n]*\\]\\([^)\\s]*\\))',
  '(?<url>https?:\\/\\/[^\\s<>)\\]]+)'
].join('|')

const text = (body: string): Inline => ({ kind: 'text', open: '', body, close: '', href: '' })

/** One level deep: bold inside a link is not worth the machinery it would take. */
export function inlines(source: string): Inline[] {
  const out: Inline[] = []
  const scan = new RegExp(INLINE, 'g')
  let last = 0

  for (let m = scan.exec(source); m; m = scan.exec(source)) {
    const g = m.groups as Record<string, string | undefined>
    // snake_case is not emphasis. An underscore only opens one from a word boundary.
    const after = source[m.index + m[0].length] ?? ''
    if (g.em && g.em.startsWith('_') && (/\w/.test(source[m.index - 1] ?? '') || /\w/.test(after))) continue

    if (m.index > last) out.push(text(source.slice(last, m.index)))
    last = m.index + m[0].length

    if (g.code) out.push({ kind: 'code', open: '`', body: g.code.slice(1, -1), close: '`', href: '' })
    else if (g.strong) {
      const mark = g.strong.slice(0, 2)
      out.push({ kind: 'strong', open: mark, body: g.strong.slice(2, -2), close: mark, href: '' })
    } else if (g.strike) out.push({ kind: 'strike', open: '~~', body: g.strike.slice(2, -2), close: '~~', href: '' })
    else if (g.em) {
      const mark = g.em.slice(0, 1)
      out.push({ kind: 'em', open: mark, body: g.em.slice(1, -1), close: mark, href: '' })
    } else if (g.link) {
      const parts = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(g.link)
      if (parts) {
        out.push({ kind: 'link', open: '[', body: parts[1] || parts[2], close: `](${parts[2]})`, href: parts[2] })
      }
    } else if (g.url) out.push({ kind: 'link', open: '', body: g.url, close: '', href: g.url })
  }

  if (last < source.length) out.push(text(source.slice(last)))
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
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '$1')
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_, label: string, href: string) => label || href)
    .replace(/(\*\*|__|~~|[*_`])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
