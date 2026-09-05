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

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DATE_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

export function formatDate(value: string | null): string {
  if (!value) return ''
  const d = parseDate(value)
  return d.getFullYear() === new Date().getFullYear() ? DATE_FMT.format(d) : DATE_YEAR_FMT.format(d)
}

export const formatLongDate = (value: string): string => WEEKDAY_FMT.format(parseDate(value))

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
