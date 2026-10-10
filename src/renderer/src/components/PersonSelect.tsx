import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Avatar } from './primitives'

/** The least a person has to be to be offered: who they are and how they are drawn. */
export interface Selectable {
  id: string
  name: string
  avatarColor: string
  avatar?: string | null
  isMe?: boolean
}

interface Option {
  id: string
  label: string
  /** A second, quieter line — why this entry is unlike the others. */
  note?: string
  person: { name: string; color: string; image?: string | null } | null
}

/** Slate, for someone the app no longer has a colour for. */
const NO_COLOR = '#64748b'

/** The empty answer, drawn as an empty seat beside the faces rather than as a face. */
function Nobody({ size }: { size: number }): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-base-content/25 text-base-content/30"
      style={{ width: size, height: size }}
    >
      <Icon name="people" size={size * 0.5} />
    </span>
  )
}

/**
 * Who owns this item: every person on offer with their face beside their name.
 *
 * A native select can only show text, and a name is the slower way to find somebody —
 * people recognise a colleague's face, or their colours, before they read the name under
 * it. So this draws the list itself, and keeps to what a select does from the keyboard:
 * Enter, Space or the arrows open it, the arrows walk it, Enter picks, Escape closes,
 * and typing the start of a name jumps to it. Focus never leaves the field, which is
 * what the listbox pattern asks for and what keeps the dialog's own focus handling and
 * Escape untouched.
 *
 * The list drops down in place, like the date picker beside it. The dialog does not
 * clip what it holds — its backdrop scrolls instead — so nothing needs moving out of it.
 */
export function PersonSelect({
  value,
  onChange,
  people,
  departed,
  label
}: {
  value: string
  onChange: (personId: string) => void
  /** The project's cast. You are listed first, as "Me". */
  people: Selectable[]
  /** Whoever owns the item today if they have since left the project, so they stay visible. */
  departed?: { id: string; name: string; color?: string | null } | null
  /** What the field is called, for anyone who cannot see the caption above it. */
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const listId = useId()

  const options = useMemo((): Option[] => {
    const me = people.find((p) => p.isMe)
    const others = people.filter((p) => !p.isMe)
    const face = (p: Selectable): Option['person'] => ({ name: p.name, color: p.avatarColor, image: p.avatar })
    return [
      { id: '', label: 'Nobody yet', person: null },
      ...(me ? [{ id: me.id, label: 'Me', person: face(me) }] : []),
      ...others.map((p) => ({ id: p.id, label: p.name, person: face(p) })),
      ...(departed
        ? [
            {
              id: departed.id,
              label: departed.name,
              note: 'No longer on this project',
              person: { name: departed.name, color: departed.color || NO_COLOR }
            }
          ]
        : [])
    ]
  }, [people, departed])

  // An id the list does not hold reads as nobody, rather than as a blank field.
  const selectedIndex = Math.max(0, options.findIndex((o) => o.id === value))
  const selected = options[selectedIndex]

  const show = (at = selectedIndex): void => {
    setActive(at)
    setOpen(true)
  }

  const pick = (index: number): void => {
    const option = options[index]
    if (option) onChange(option.id)
    setOpen(false)
  }

  // Escape closes the list and nothing else: caught before the dialog hears it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    // Captured, because the dialog stops a press inside it from reaching the window.
    const onPress = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPress, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPress, true)
    }
  }, [open])

  // The highlighted row stays in view as the arrows walk past the bottom of the list.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  /** Typing the start of a name jumps to it; a pause starts the word over. */
  const typeAhead = (key: string): void => {
    const now = Date.now()
    const text = (now - typed.current.at > 600 ? '' : typed.current.text) + key.toLowerCase()
    typed.current = { text, at: now }
    const from = open ? active : selectedIndex
    // A repeated letter cycles through everyone starting with it.
    const search = text.split('').every((c) => c === text[0]) ? text[0] : text
    const start = search.length === 1 ? from + 1 : from
    for (let i = 0; i < options.length; i++) {
      const index = (start + i) % options.length
      if (options[index].label.toLowerCase().startsWith(search)) {
        show(index)
        return
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const last = options.length - 1
    // A space in the middle of typing a name is part of the name, not a choice.
    const typing = typed.current.text !== '' && Date.now() - typed.current.at <= 600
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) show()
      else setActive((i) => Math.min(last, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      show(e.key === 'Home' ? 0 : last)
    } else if (e.key === 'Enter' || (e.key === ' ' && !typing)) {
      // Never the dialog's Enter: picking someone is not saving the item.
      e.preventDefault()
      if (open) pick(active)
      else show()
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      typeAhead(e.key)
    }
  }

  const face = (option: Option, size: number): React.JSX.Element =>
    option.person ? (
      <Avatar name={option.person.name} color={option.person.color} image={option.person.image} size={size} />
    ) : (
      <Nobody size={size} />
    )

  return (
    <div className="relative" ref={containerRef}>
      <div
        role="combobox"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className="hairline row-hover flex h-10 w-full cursor-pointer items-center gap-2 rounded-field border bg-base-100 px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {face(selected, 22)}
        <span className={`min-w-0 flex-1 truncate ${selected.id ? '' : 'text-base-content/45'}`}>
          {selected.label}
        </span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} className="shrink-0 text-base-content/35" />
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="rise hairline scroll-area absolute inset-x-0 top-full z-50 mt-1 max-h-64 min-w-[13rem] overflow-y-auto rounded-box border bg-base-100 py-1 shadow-xl shadow-black/15"
          // Keeps focus on the field, so picking a row is not also a blur that closes it.
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.id || 'nobody'}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              className={`flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-[13px] ${
                index === active ? 'bg-base-200' : ''
              }`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(index)}
            >
              {face(option, 22)}
              <span className="min-w-0 flex-1">
                <span className={`block truncate ${option.id ? '' : 'text-base-content/55'}`}>{option.label}</span>
                {option.note && (
                  <span className="block truncate text-[11px] text-base-content/45">{option.note}</span>
                )}
              </span>
              {index === selectedIndex && <Icon name="check" size={13} className="shrink-0 text-primary" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
