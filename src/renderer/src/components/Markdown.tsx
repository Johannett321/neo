import { Fragment, type ReactNode } from 'react'
import { calloutOf, classify, fenced, inlines, tableAt, type Block, type CalloutType } from '@/lib/markdown'
import { openExternal } from '@/lib/api'
import { Icon, type IconName } from './Icon'

/**
 * Markdown, rendered.
 *
 * The editor in this app styles Markdown *in place* — the characters stay where they
 * are, because you are editing them. The assistant's replies are the opposite case:
 * nobody edits them, so the syntax should be gone and the heading should just be a
 * heading. Both read the same parser in `lib/markdown.ts`, so a bullet means the same
 * thing whether you wrote it or it did.
 *
 * Hand-rolled for the reason everything here is: the parser already exists, the
 * alternative is a Markdown library and a sanitiser carried around for one panel, and
 * nothing on this page is untrusted in the way a web page's Markdown is — it is a
 * reply to a question you asked, rendered as elements rather than as HTML, so there
 * is no string of markup anywhere for something to hide inside.
 */

/** Bold, italic, code, strikethrough and links, with the syntax taken off. */
function Inline({ source }: { source: string }): React.JSX.Element {
  return (
    <>
      {inlines(source).map((part, i) => {
        switch (part.kind) {
          case 'strong':
            return part.open === '***' ? (
              <strong key={i}>
                <em>{part.body}</em>
              </strong>
            ) : (
              <strong key={i}>{part.body}</strong>
            )
          case 'em':
            return <em key={i}>{part.body}</em>
          case 'strike':
            return <s key={i}>{part.body}</s>
          case 'code':
            return <code key={i}>{part.body}</code>
          case 'image':
            /*
             * An illustration, and only ever one of the app's own.
             *
             * The renderer will draw a picture for `neo-media://` and for nothing
             * else. That is not squeamishness about the syntax — it is that the CSP
             * allows an image from `self` and a data URL and nothing more, so an
             * `https://` image pasted into a note would draw a broken-image icon and
             * a `file://` one would be a renderer that had learned a path. Both are
             * worse than the alt text, which is what they get instead.
             */
            return part.href.startsWith('neo-media://') ? (
              <img key={i} src={part.href} alt={part.body} className="md-inline-image" style={sized(part.size)} />
            ) : (
              <Fragment key={i}>{part.body || part.href}</Fragment>
            )
          case 'wiki':
            // A link between notes. Nothing here can follow it — this is the
            // assistant's panel and a changelog — so it is drawn as one and left.
            return (
              <span key={i} className="wk">
                {part.body}
              </span>
            )
          case 'link':
            return (
              <a
                key={i}
                href={part.href}
                onClick={(e) => {
                  // Every link leaves for the real browser; nothing navigates the app.
                  e.preventDefault()
                  openExternal(part.href)
                }}
              >
                {part.body || part.href}
              </a>
            )
          default:
            return <Fragment key={i}>{part.body}</Fragment>
        }
      })}
    </>
  )
}

/** `|300` or `|300x200` on an image, as the style it means. */
function sized(size: string): React.CSSProperties | undefined {
  if (!size) return undefined
  const [w, h] = size.split('x')
  return { width: `${w}px`, height: h ? `${h}px` : undefined, maxHeight: 'none' }
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

interface ListItem {
  block: Block
  children: string[]
}

function List({ items, ordered }: { items: ListItem[]; ordered: boolean }): React.JSX.Element {
  const Tag = ordered ? 'ol' : 'ul'
  const start = ordered ? Number(items[0]?.block.ordinal.slice(0, -1)) || 1 : undefined
  return (
    <Tag start={start}>
      {items.map((item, i) => (
        <li key={i} className={item.block.kind === 'task' ? 'task' : undefined}>
          {item.block.kind === 'task' && (
            <span className={`tick ${item.block.checked ? 'on' : ''}`} aria-hidden="true" />
          )}
          <Inline source={item.block.text} />
          {/* Nested lines under an item are its own paragraph, not a new item. */}
          {item.children.length > 0 && (
            <div className="sub">
              <Markdown source={item.children.join('\n')} />
            </div>
          )}
        </li>
      ))}
    </Tag>
  )
}

/**
 * Turns Markdown into elements. Deliberately a flat pass over lines rather than a
 * tree: everything an assistant actually writes — headings, paragraphs, lists,
 * quotes, code, tables — is line-shaped, and a real block parser would be a lot of
 * machinery to render one more level of nesting nobody asks for.
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }): React.JSX.Element {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const inCode = fenced(lines)
  const out: ReactNode[] = []

  let i = 0
  while (i < lines.length) {
    const raw = lines[i]

    // A fence and everything inside it, kept exactly as written.
    if (!inCode[i] && classify(raw, false).kind === 'fence') {
      const language = raw.trim().replace(/^(?:```|~~~)/, '').trim()
      const body: string[] = []
      i++
      while (i < lines.length && inCode[i]) body.push(lines[i++])
      // The closing fence, if the model remembered one.
      if (i < lines.length && classify(lines[i], false).kind === 'fence') i++
      out.push(
        <pre key={out.length}>
          {language && <span className="lang">{language}</span>}
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    if (!raw.trim()) {
      i++
      continue
    }

    const table = tableAt(lines, i, inCode)
    if (table) {
      const rows = lines.slice(table.start, table.end).map(cellsOf)
      const [head, ...body] = [rows[0], ...rows.slice(2)]
      out.push(
        <div className="tablewrap" key={out.length}>
          <table>
            <thead>
              <tr>
                {head.map((c, x) => (
                  <th key={x} style={{ textAlign: table.align[x] as 'left' }}>
                    <Inline source={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, y) => (
                <tr key={y}>
                  {head.map((_, x) => (
                    <td key={x} style={{ textAlign: table.align[x] as 'left' }}>
                      <Inline source={row[x] ?? ''} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      i = table.end
      continue
    }

    const block = classify(raw, false)

    if (block.kind === 'rule') {
      out.push(<hr key={out.length} />)
      i++
      continue
    }

    if (block.kind.startsWith('h') && block.kind.length === 2) {
      const Tag = block.kind as 'h1'
      out.push(
        <Tag key={out.length}>
          <Inline source={block.text} />
        </Tag>
      )
      i++
      continue
    }

    if (block.kind === 'quote') {
      const body: string[] = []
      while (i < lines.length && !inCode[i] && classify(lines[i], false).kind === 'quote') {
        body.push(classify(lines[i], false).text)
        i++
      }
      const callout = calloutOf(body[0])
      if (callout) {
        // Folded shut with `-`: the title stands for the whole thing, as Obsidian
        // draws it. Nothing here can open it, so it is a summary rather than a toggle.
        out.push(
          <aside key={out.length} className="callout" data-callout={callout.type}>
            <div className="callout-head">
              <Icon name={CALLOUT_ICON[callout.type]} size={15} />
              <Inline source={callout.title || callout.typed} />
            </div>
            {callout.fold !== '-' && body.length > 1 && <Markdown source={body.slice(1).join('\n')} />}
          </aside>
        )
        continue
      }
      out.push(
        <blockquote key={out.length}>
          <Markdown source={body.join('\n')} />
        </blockquote>
      )
      continue
    }

    if (block.kind === 'bullet' || block.kind === 'number' || block.kind === 'task') {
      const ordered = block.kind === 'number'
      const items: ListItem[] = []
      while (i < lines.length && !inCode[i]) {
        const line = classify(lines[i], false)
        const isItem = line.kind === 'bullet' || line.kind === 'number' || line.kind === 'task'
        if (!isItem) {
          // An indented continuation belongs to the item above it.
          if (items.length > 0 && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].children.push(lines[i].trimStart())
            i++
            continue
          }
          break
        }
        if ((line.kind === 'number') !== ordered) break
        items.push({ block: line, children: [] })
        i++
      }
      out.push(<List key={out.length} items={items} ordered={ordered} />)
      continue
    }

    // A run of plain lines is one paragraph; a blank line ends it.
    const paragraph: string[] = []
    while (i < lines.length && !inCode[i] && lines[i].trim() && classify(lines[i], false).kind === 'p') {
      paragraph.push(lines[i].trim())
      i++
    }
    if (paragraph.length === 0) {
      // A line that classified as something structural but was not handled above —
      // render it as words rather than dropping it on the floor.
      paragraph.push(raw.trim())
      i++
    }
    const text = paragraph.join(' ')
    /*
     * A line that is nothing but an illustration is a figure rather than a sentence
     * with a picture in it: full width, with its alt text as the caption underneath.
     * This is what lets a changelog be a page of screenshots and a note be a note,
     * out of the same syntax and with nothing to choose between.
     */
    const figure = /^!\[([^\]]*?)(?:\|(\d+(?:x\d+)?))?\]\((neo-media:\/\/[^)\s]+)\)$/.exec(text.trim())
    out.push(
      figure ? (
        <figure key={out.length} className="md-figure">
          <img src={figure[3]} alt={figure[1]} style={figure[2] ? { ...sized(figure[2]), maxWidth: '100%' } : undefined} />
          {figure[1] && <figcaption>{figure[1]}</figcaption>}
        </figure>
      ) : (
        <p key={out.length}>
          <Inline source={text} />
        </p>
      )
    )
  }

  return <div className={`md ${className}`}>{out}</div>
}

/** A row of pipes, split into cells, with the outer pipes discarded. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}
