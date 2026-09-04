import { useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'

/** Roles are stored as one comma-separated string; the UI treats them as a list. */
export const parseRoles = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

export const formatRoles = (roles: string[]): string => roles.join(', ')

const dedupe = (roles: string[]): string[] => {
  const seen = new Set<string>()
  return roles.filter((role) => {
    const key = role.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A person rarely has exactly one role — they are the tech lead *and* the person who
 * signs off releases. Each one becomes a badge; a comma or Enter commits what you have
 * typed, Backspace on an empty field takes the last one back, and the suggestions are
 * roles already used elsewhere in this workspace, so the vocabulary stays consistent
 * without being enforced.
 */
export function RoleInput({
  roles,
  onChange,
  suggestions,
  placeholder = 'Tech lead, client contact…',
  autoFocus = false
}: {
  roles: string[]
  onChange: (roles: string[]) => void
  suggestions: string[]
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const available = useMemo(() => {
    const taken = new Set(roles.map((r) => r.toLowerCase()))
    const needle = draft.trim().toLowerCase()
    return suggestions
      .filter((s) => !taken.has(s.toLowerCase()))
      .filter((s) => (needle ? s.toLowerCase().includes(needle) : true))
      .slice(0, 8)
  }, [suggestions, roles, draft])

  const add = (role: string): void => {
    const clean = role.trim()
    if (!clean) return
    onChange(dedupe([...roles, clean]))
    setDraft('')
    setCursor(0)
    inputRef.current?.focus()
  }

  const removeAt = (index: number): void => onChange(roles.filter((_, i) => i !== index))

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === ',' || (e.key === 'Enter' && draft.trim())) {
      e.preventDefault()
      // Enter takes the highlighted suggestion when the list is showing one.
      const highlighted = open && available[cursor]
      add(e.key === 'Enter' && highlighted ? highlighted : draft)
      return
    }
    if (e.key === 'Backspace' && !draft && roles.length > 0) {
      e.preventDefault()
      removeAt(roles.length - 1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setCursor((c) => (available.length ? (c + 1) % available.length : 0))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (available.length ? (c - 1 + available.length) % available.length : 0))
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <div
        className="hairline flex min-h-10 flex-wrap items-center gap-1.5 rounded-field border bg-base-100 px-2 py-1.5 focus-within:border-primary/50"
        onClick={() => inputRef.current?.focus()}
      >
        {roles.map((role, index) => (
          <span
            key={`${role}-${index}`}
            className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-[12px] text-primary"
          >
            {role}
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center rounded-full opacity-50 transition hover:bg-primary/20 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                removeAt(index)
              }}
              aria-label={`Remove ${role}`}
            >
              <Icon name="close" size={9} strokeWidth={2.4} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-base-content/30"
          placeholder={roles.length === 0 ? placeholder : 'Add another…'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
            setCursor(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Commit what is half-typed rather than silently dropping it.
            window.setTimeout(() => {
              setOpen(false)
              if (draft.trim()) add(draft)
            }, 120)
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && available.length > 0 && (
        <div className="rise hairline scroll-area absolute left-0 right-0 top-full z-20 mt-1 max-h-44 overflow-y-auto rounded-box border bg-base-100 py-1 shadow-xl shadow-black/10">
          {available.map((suggestion, index) => (
            <button
              key={suggestion}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition ${
                index === cursor ? 'bg-base-200' : 'hover:bg-base-200'
              }`}
              onMouseEnter={() => setCursor(index)}
              onMouseDown={(e) => {
                e.preventDefault()
                add(suggestion)
              }}
            >
              <Icon name="plus" size={11} className="text-base-content/35" />
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Roles rendered as badges wherever they are only being read. */
export function RoleBadges({
  value,
  className = ''
}: {
  value: string
  className?: string
}): React.JSX.Element {
  const roles = parseRoles(value)
  if (roles.length === 0) {
    return <span className={`text-[11px] text-base-content/40 ${className}`}>No role set</span>
  }
  return (
    <span className={`flex flex-wrap items-center gap-1 ${className}`}>
      {roles.map((role) => (
        <span
          key={role}
          className="rounded-full bg-base-content/[0.06] px-1.5 py-px text-[10px] text-base-content/60"
        >
          {role}
        </span>
      ))}
    </span>
  )
}
