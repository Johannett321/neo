import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchHit } from '@shared/types'
import { useApi } from '@/lib/api'
import { projectColor } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { Icon, type IconName } from './Icon'
import { Kbd } from './primitives'

const KIND_ICON: Record<SearchHit['kind'], IconName> = {
  project: 'folder',
  task: 'check',
  person: 'people',
  note: 'note',
  decision: 'decision',
  journal: 'journal'
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  project: 'Project',
  task: 'Item',
  person: 'Person',
  note: 'Note',
  decision: 'Decision',
  journal: 'Journal'
}

const NAV: { label: string; to: string; icon: IconName }[] = [
  { label: 'Today', to: '/', icon: 'today' },
  { label: 'Projects', to: '/projects', icon: 'projects' },
  { label: 'People', to: '/people', icon: 'people' },
  { label: 'Settings', to: '/settings', icon: 'settings' }
]

/** One row of the list, whatever it happens to be. */
interface Row {
  key: string
  icon: IconName
  colour?: string
  title: string
  subtitle?: string
  meta: string
  to: string
}

/** One keystroke to anything: projects, people, notes, decisions, journal, tasks. */
export function CommandPalette({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [term, setTerm] = useState('')
  const [cursor, setCursor] = useState(0)
  const navigate = useNavigate()
  const listRef = useRef<HTMLDivElement>(null)
  const workspace = useWorkspace()

  const query = term.trim()
  /** Under two characters there is nothing to search, so it offers instead. */
  const browsing = query.length < 2

  const results = useApi('search:query', { q: term, workspaceId: workspace.id }, { enabled: open && !browsing })
  // Already in the cache: the sidebar warms this key on hover and Today reads it.
  const projects = useApi(
    'project:list',
    { workspaceId: workspace.id, status: 'all', archived: false },
    { enabled: open }
  )

  /**
   * An empty search box used to answer with four navigation links and an instruction
   * to type. Most of the time what you wanted was a project you had open this week,
   * and the app knows which those are — so it puts them there before asking for a
   * single keystroke, most recently opened first.
   */
  const rows = useMemo<Row[]>(() => {
    const nav: Row[] = NAV.filter((n) => n.label.toLowerCase().includes(query.toLowerCase())).map((n) => ({
      key: `nav-${n.to}`,
      icon: n.icon,
      title: n.label,
      meta: 'Go to',
      to: n.to
    }))

    if (browsing) {
      const recent = [...(projects.data ?? [])]
        .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
        .slice(0, 6)
        .map<Row>((p) => ({
          key: `recent-${p.id}`,
          icon: 'folder',
          colour: projectColor(p),
          title: p.name,
          subtitle: p.attention ?? p.summary,
          meta: 'Project',
          to: `/projects/${p.id}`
        }))
      return [...recent, ...nav]
    }

    const hits: Row[] = (results.data ?? []).map((hit) => ({
      key: `${hit.kind}-${hit.id}`,
      icon: KIND_ICON[hit.kind],
      colour: hit.color,
      title: hit.title,
      subtitle: hit.snippet ? `${hit.subtitle} — ${hit.snippet}` : hit.subtitle,
      meta: KIND_LABEL[hit.kind],
      to:
        hit.kind === 'person'
          ? `/people/${hit.id}`
          : hit.kind === 'project'
            ? `/projects/${hit.id}`
            : // A note has a page of its own, so search lands on the note, not near it.
              hit.kind === 'note' && hit.projectId
              ? `/projects/${hit.projectId}/notes/${hit.id}`
              : hit.projectId
                ? `/projects/${hit.projectId}`
                : '/projects'
    }))
    return [...nav, ...hits]
  }, [browsing, query, projects.data, results.data])

  useEffect(() => {
    if (open) {
      setTerm('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => setCursor(0), [term])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // Escape has to work wherever focus has ended up, not only inside the input.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const go = (index: number): void => {
    const row = rows[index]
    if (!row) return
    navigate(row.to)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const total = rows.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (total === 0 ? 0 : (c + 1) % total))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (total === 0 ? 0 : (c - 1 + total) % total))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(cursor)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  /** Where the heading goes, if anywhere: above the first row of each group. */
  const headingAt = (index: number): string | null => {
    const row = rows[index]
    if (!row) return null
    const previous = rows[index - 1]
    const group = (r: Row): string =>
      r.key.startsWith('recent-') ? 'Jump back in' : r.key.startsWith('nav-') ? 'Go to' : 'Results'
    if (!browsing && group(row) !== 'Results') return null
    return previous && group(previous) === group(row) ? null : group(row)
  }

  return (
    <div
      // Marks the screen as covered: Escape belongs to whatever is on top of it.
      data-overlay
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 p-6 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="rise hairline w-full max-w-2xl overflow-hidden rounded-box border bg-base-100 shadow-2xl shadow-black/20"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hairline flex items-center gap-3 border-b px-4">
          <Icon name="search" size={16} className="text-base-content/35" />
          <input
            autoFocus
            className="w-full bg-transparent py-3.5 text-[15px] outline-none placeholder:text-base-content/30"
            placeholder={`Search ${workspace.name}…`}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="scroll-area max-h-[52vh] py-1.5">
          {rows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-base-content/40">
              {browsing ? 'Type to search everything.' : 'Nothing found.'}
            </div>
          )}

          {rows.map((row, index) => {
            const heading = headingAt(index)
            return (
              <div key={row.key}>
                {heading && (
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-base-content/35">
                    {heading}
                  </div>
                )}
                <button
                  data-active={cursor === index}
                  className="flex w-full items-start gap-3 px-4 py-2 text-left data-[active=true]:bg-base-200"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(index)}
                >
                  <span className="mt-0.5" style={row.colour ? { color: row.colour } : undefined}>
                    <Icon name={row.icon} size={15} className={row.colour ? '' : 'text-base-content/40'} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{row.title}</span>
                    {row.subtitle && (
                      <span className="block truncate text-[11px] text-base-content/45">{row.subtitle}</span>
                    )}
                  </span>
                  <span className="mt-0.5 shrink-0 text-[11px] text-base-content/35">{row.meta}</span>
                </button>
              </div>
            )
          })}
        </div>

        <div className="hairline flex items-center gap-3 border-t px-4 py-2 text-[11px] text-base-content/40">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
        </div>
      </div>
    </div>
  )
}
