import { resolveTemperature, type ClockFormat, type DateFormat, type TemperatureUnits } from '@shared/formats'

/** Local calendar day as YYYY-MM-DD — never UTC, or "today" drifts after 01:00. */
export function todayStr(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function daysBetween(from: string, to: string): number {
  const at = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

export function addDays(value: string, days: number): string {
  const d = parseDate(value)
  d.setDate(d.getDate() + days)
  return todayStr(d)
}

/* ------------------------------------------------------ how a date is written */

/**
 * The order the parts of a date come in, and whether the clock counts to twelve.
 *
 * Held in a module rather than passed down, because `formatDate` is called from about
 * sixty places and none of them are the right place to be told about a preference.
 * `applyDisplayPreferences` is called during the render of the provider at the top of
 * the app, *before* anything below it draws, so a changed setting is already in force
 * on the frame that follows it — an effect would leave one stale frame behind.
 *
 * `system` is the default and means the formatters are left exactly as they were: the
 * operating system already knows, and for almost everybody it is right. The other
 * choices reorder the parts and keep the machine's own month and weekday names, which
 * is why they are built out of `formatToParts` rather than out of a forced locale —
 * a Norwegian who writes the month first still wants "sep", not "Sep".
 */
let clockChoice: ClockFormat = 'system'
let dateChoice: DateFormat = 'system'
let temperatureChoice: TemperatureUnits = 'system'

let DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
let DATE_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
let WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
let TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function applyDisplayPreferences(next: {
  clockFormat: ClockFormat
  dateFormat: DateFormat
  temperatureUnits: TemperatureUnits
}): void {
  clockChoice = next.clockFormat
  dateChoice = next.dateFormat
  temperatureChoice = next.temperatureUnits
  TIME_FMT = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    // Undefined rather than a value: that is what leaves the locale to decide, and
    // `hour12: false` is not the same thing — it forces 24 even where 12 is right.
    hour12: clockChoice === '12' ? true : clockChoice === '24' ? false : undefined
  })
}

/** What "system" resolves to for a temperature, so a degree sign never guesses. */
export const temperatureUnits = (): 'c' | 'f' => resolveTemperature(temperatureChoice)

const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string =>
  parts.find((p) => p.type === type)?.value ?? ''

export function formatDate(value: string | null): string {
  return formatDateWith(dateChoice, value)
}

export function formatLongDate(value: string): string {
  return formatLongDateWith(dateChoice, value)
}

/**
 * The same two functions with the choice passed in rather than read off the module.
 *
 * They exist so the settings screen can show what each option looks like *by
 * formatting a date with it*, rather than by writing the example out by hand — a
 * preview typed into the UI is a preview that can quietly stop being true. Nothing
 * global is touched, which is the point: previewing four options must not leave the
 * application drawing dates in the last one that was hovered.
 */
export function formatDateWith(choice: DateFormat, value: string | null): string {
  if (!value) return ''
  const d = parseDate(value)
  const withYear = d.getFullYear() !== new Date().getFullYear()
  const formatter = withYear ? DATE_YEAR_FMT : DATE_FMT
  if (choice === 'system') return formatter.format(d)
  if (choice === 'ymd') return todayStr(d)

  const parts = formatter.formatToParts(d)
  const day = part(parts, 'day')
  const month = part(parts, 'month')
  const year = withYear ? part(parts, 'year') : ''
  return choice === 'dmy'
    ? `${day} ${month}${year ? ` ${year}` : ''}`
    : `${month} ${day}${year ? `, ${year}` : ''}`
}

export function formatLongDateWith(choice: DateFormat, value: string): string {
  const d = parseDate(value)
  if (choice === 'system') return WEEKDAY_FMT.format(d)

  const parts = WEEKDAY_FMT.formatToParts(d)
  const weekday = part(parts, 'weekday')
  if (choice === 'ymd') return `${weekday}, ${todayStr(d)}`
  const day = part(parts, 'day')
  const month = part(parts, 'month')
  return choice === 'dmy' ? `${weekday}, ${day} ${month}` : `${weekday}, ${month} ${day}`
}

/** The wall clock, to the minute, counting to twelve or to twenty-four as told. */
export const formatTime = (at: Date): string => TIME_FMT.format(at)

/** One clock choice, for the same reason `formatDateWith` exists. */
export const formatTimeWith = (choice: ClockFormat, at: Date): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: choice === '12' ? true : choice === '24' ? false : undefined
  }).format(at)

/** A temperature, in the unit it was actually read in. */
export const formatTemperature = (value: number, units: 'c' | 'f'): string =>
  `${value}°${units === 'f' ? 'F' : 'C'}`

/** "Overdue by 3 days", "Today", "In 4 days" — the phrasing people actually think in. */
export function dueLabel(days: number | null): string {
  if (days === null) return ''
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days < 0) return `${Math.abs(days)} days ago`
  if (days <= 13) return `In ${days} days`
  const weeks = Math.round(days / 7)
  return `In ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
}

export function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never'
  const days = daysBetween(todayStr(new Date(iso)), todayStr())
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 60) return 'a month ago'
  if (days < 365) return `${Math.round(days / 30)} months ago`
  return 'over a year ago'
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase()
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase()
}

export const plural = (n: number, singular: string, pluralForm?: string): string =>
  `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  dormant: 'Dormant',
  done: 'Done'
}

export const KIND_LABEL: Record<string, string> = {
  task: 'Task',
  delegated: 'Delegated'
}

export const LINK_KIND_LABEL: Record<string, string> = {
  repo: 'Repository',
  board: 'Board',
  design: 'Design',
  docs: 'Docs',
  chat: 'Chat',
  drive: 'Drive',
  staging: 'Environment',
  other: 'Link'
}

/** Suggestions only — the role field stays free text, because real roles are messy. */
export const ROLE_SUGGESTIONS = [
  'Tech lead', 'Product owner', 'Designer', 'Developer', 'QA', 'Stakeholder',
  'Client contact', 'Budget owner', 'Co-founder', 'Manager', 'Analyst'
]

/** Shallow-serialising comparison, for telling a form that has been edited from one that has not. */
export const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

/**
 * A project shows its own colour once it has been given one, and its workspace's
 * until then — so a workspace still reads as one family, and the projects you have
 * deliberately marked stand out from it.
 *
 * Takes a project (`color`) or anything carrying a project's colour alongside its
 * own (`projectColor` — a task view, say), because the fallback rule has to be the
 * same one wherever a project's colour is drawn.
 */
export const projectColor = (p: {
  color?: string
  projectColor?: string
  workspaceColor: string
}): string => p.color || p.projectColor || p.workspaceColor

/**
 * A file size in the unit a person would say out loud. Base 1000 rather than 1024,
 * because that is what the Finder shows and a recording that disagrees with the
 * Finder about its own size is a recording you do not trust.
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 MB'
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

/** A running time, as a clock: 4:07, or 1:12:30 once it passes an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
