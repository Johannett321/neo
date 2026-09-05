import { daysBetween, formatDate, todayStr } from '@/lib/format'
import { Icon } from './Icon'

/**
 * Deadline wording, which is not task wording. A task that slipped was due "3 days
 * ago"; a project deadline is "3 days over", and the time you have left is the thing
 * worth naming rather than the date it happens to fall on.
 */
export function deadlineLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} over`
  if (days === 0) return 'Due today'
  if (days === 1) return '1 day left'
  if (days <= 13) return `${days} days left`
  const weeks = Math.round(days / 7)
  return weeks <= 8 ? `${weeks} weeks left` : `${Math.round(days / 30)} months left`
}

/**
 * How much of the run-up to a deadline has already gone.
 *
 * A date on its own is arithmetic you have to do yourself — "the 12th" means nothing
 * until you work out that it is a fortnight away and you have had three months. The
 * bar measures from the day the project was created, so what you read is how much of
 * the time you were ever going to have is left.
 *
 * The fill carries the project's own colour while there is room, and gives that up for
 * amber and then red as the date closes in: for a fortnight either side of a deadline,
 * urgency is worth more than identity.
 */
export function DeadlineBar({
  deadline,
  createdAt,
  color
}: {
  deadline: string
  createdAt: string
  color: string
}): React.JSX.Element {
  const today = todayStr()
  const start = createdAt.slice(0, 10)
  const left = daysBetween(today, deadline)
  const total = daysBetween(start, deadline)
  const elapsed = daysBetween(start, today)

  // A deadline set on or before the day the project began has no run-up to show.
  const fraction = total <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / total))
  const overdue = left < 0
  const soon = !overdue && left <= 14

  const tone = overdue ? 'text-error' : soon ? 'text-warning' : 'text-base-content/45'
  const fill = overdue
    ? 'var(--color-error)'
    : soon
      ? 'var(--color-warning)'
      : color

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-base-content/45">
          <Icon name="flag" size={10} className="shrink-0" />
          <span className="truncate">{formatDate(deadline)}</span>
        </span>
        <span className={`shrink-0 font-medium tabular-nums ${tone}`}>{deadlineLabel(left)}</span>
      </div>
      <div className="h-[5px] w-full overflow-hidden rounded-full bg-base-content/[0.08]" aria-hidden="true">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(fraction * 100, 2)}%`, backgroundColor: fill }}
        />
      </div>
    </div>
  )
}
