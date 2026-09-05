import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchHit } from '@shared/types'
import { useApi } from '@/lib/api'
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

  const results = useApi(
    'search:query',
    { q: term, workspaceId: workspace.id },
    { enabled: open && term.trim().length >= 2 }
  )

  const navMatches = useMemo(
    () => NAV.filter((n) => n.label.toLowerCase().includes(term.trim().toLowerCase())),
    [term]
  )
  const hits = results.data ?? []
  const total = navMatches.length + hits.length

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
    if (index < navMatches.length) {
      const item = navMatches[index]
      if (item) navigate(item.to)
    } else {
      const hit = hits[index - navMatches.length]
      if (!hit) return
      if (hit.kind === 'person') navigate(`/people/${hit.id}`)
      else if (hit.kind === 'project') navigate(`/projects/${hit.id}`)
      // A note has a page of its own, so the search lands on the note, not near it.
      else if (hit.kind === 'note' && hit.projectId) navigate(`/projects/${hit.projectId}/notes/${hit.id}`)
      else if (hit.projectId) navigate(`/projects/${hit.projectId}`)
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
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
          {total === 0 && (
            <div className="px-4 py-8 text-center text-sm text-base-content/40">
              {term.trim().length < 2 ? 'Type to search everything.' : 'Nothing found.'}
            </div>
          )}

          {navMatches.map((item, i) => (
            <button
              key={item.to}
              data-active={cursor === i}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm data-[active=true]:bg-base-200"
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(i)}
            >
              <Icon name={item.icon} size={15} className="text-base-content/40" />
              <span>{item.label}</span>
              <span className="ml-auto text-[11px] text-base-content/35">Go to</span>
            </button>
          ))}

          {hits.map((hit, i) => {
            const index = navMatches.length + i
            return (
              <button
                key={`${hit.kind}-${hit.id}`}
                data-active={cursor === index}
                className="flex w-full items-start gap-3 px-4 py-2 text-left data-[active=true]:bg-base-200"
                onMouseEnter={() => setCursor(index)}
                onClick={() => go(index)}
              >
                <span className="mt-0.5" style={{ color: hit.color }}>
                  <Icon name={KIND_ICON[hit.kind]} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{hit.title}</span>
                  <span className="block truncate text-[11px] text-base-content/45">
                    {hit.subtitle}
                    {hit.snippet && ` — ${hit.snippet}`}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-[11px] text-base-content/35">{KIND_LABEL[hit.kind]}</span>
              </button>
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
