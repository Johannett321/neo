import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, formatDate, parseDate, todayStr } from '@/lib/format'
import { Icon } from './Icon'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Monday-first grid for the month containing `anchor`, padded to whole weeks. */
function monthGrid(anchor: string): (string | null)[] {
  const date = parseDate(anchor)
  const year = date.getFullYear()
  const month = date.getMonth()
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = (first.getDay() + 6) % 7

  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let day = 1; day <= daysInMonth; day++) cells.push(todayStr(new Date(year, month, day)))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

const shiftMonth = (anchor: string, delta: number): string => {
  const date = parseDate(anchor)
  return todayStr(new Date(date.getFullYear(), date.getMonth() + delta, 1))
}

/** The Monday after today, which is what "next week" means to most people. */
function nextMonday(): string {
  const today = todayStr()
  const day = parseDate(today).getDay()
  return addDays(today, ((8 - day) % 7) || 7)
}

/**
 * The native date input is a different shape and a different interaction on every
 * platform, and it buries the answer people actually want — today, tomorrow, Friday.
 * This puts the shortcuts and the calendar in the same popover, opened by clicking
 * the field itself.
 */
export function DateField({
  value,
  onChange,
  placeholder = 'No date',
  allowClear = true,
  className = ''
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  allowClear?: boolean
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => value || todayStr())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setMonth(value || todayStr())
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const today = todayStr()
  const cells = useMemo(() => monthGrid(month), [month])
  const monthLabel = useMemo(
    () => parseDate(month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    [month]
  )

  const shortcuts: [string, string][] = [
    ['Today', today],
    ['Tomorrow', addDays(today, 1)],
    ['Next Monday', nextMonday()],
    ['In a week', addDays(today, 7)],
    ['In a month', addDays(today, 30)]
  ]

  const pick = (next: string): void => {
    onChange(next)
    setOpen(false)
  }

  const relative = value
    ? value === today
      ? 'Today'
      : value === addDays(today, 1)
        ? 'Tomorrow'
        : formatDate(value)
    : ''

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        className="hairline row-hover flex h-10 w-full items-center gap-2 rounded-field border bg-base-100 px-3 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="timeline" size={14} className="shrink-0 text-base-content/35" />
        <span className={value ? '' : 'text-base-content/35'}>{relative || placeholder}</span>
        {value && allowClear && (
          <span
            role="button"
            tabIndex={-1}
            className="ml-auto rounded p-0.5 text-base-content/30 transition hover:text-base-content"
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            aria-label="Clear date"
          >
            <Icon name="close" size={12} />
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="rise hairline absolute left-0 top-full z-50 mt-1 w-[17rem] rounded-box border bg-base-100 p-2 shadow-xl shadow-black/15">
            <div className="mb-2 flex flex-wrap gap-1">
              {shortcuts.map(([label, date]) => (
                <button
                  key={label}
                  type="button"
                  className={`rounded-field px-2 py-1 text-[11px] transition ${
                    value === date
                      ? 'bg-primary text-primary-content'
                      : 'text-base-content/65 hover:bg-base-200'
                  }`}
                  onClick={() => pick(date)}
                >
                  {label}
                </button>
              ))}
              {allowClear && (
                <button
                  type="button"
                  className="rounded-field px-2 py-1 text-[11px] text-base-content/50 transition hover:bg-base-200"
                  onClick={() => pick('')}
                >
                  No date
                </button>
              )}
            </div>

            <div className="hairline mb-1.5 flex items-center gap-1 border-t pt-2">
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle"
                onClick={() => setMonth(shiftMonth(month, -1))}
                aria-label="Previous month"
              >
                <Icon name="chevronRight" size={12} className="rotate-180" />
              </button>
              <span className="flex-1 text-center text-[12px] font-medium">{monthLabel}</span>
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle"
                onClick={() => setMonth(shiftMonth(month, 1))}
                aria-label="Next month"
              >
                <Icon name="chevronRight" size={12} />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((day, i) => (
                <div key={i} className="pb-1 text-center text-[10px] text-base-content/35">
                  {day}
                </div>
              ))}
              {cells.map((date, i) =>
                date === null ? (
                  <div key={i} />
                ) : (
                  <button
                    key={date}
                    type="button"
                    className={`h-7 rounded-field text-[12px] tabular-nums transition ${
                      value === date
                        ? 'bg-primary font-medium text-primary-content'
                        : date === today
                          ? 'font-semibold text-primary hover:bg-base-200'
                          : 'text-base-content/75 hover:bg-base-200'
                    }`}
                    onClick={() => pick(date)}
                  >
                    {parseDate(date).getDate()}
                  </button>
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
