/**
 * What makes a project ask to be looked at.
 *
 * This replaces the derived health level. The level was a colour you had to decode —
 * amber meant *something*, and you had to hover to find out what — so it has gone and
 * the fact itself is what surfaces instead. There is still nothing here for you to
 * maintain by hand: every reason below is read off the work, never self-reported.
 */
export const THRESHOLDS = {
  /** A project nobody has touched in this long is standing still. */
  stillAfterDays: 7,
  /** A project deadline starts mattering this far out. */
  deadlineSoonDays: 14
} as const

export interface AttentionInput {
  status: string
  daysSinceActivity: number
  openTasks: number
  overdueTasks: number
  /** Days past due for the oldest overdue item. */
  worstOverdueDays: number
  /** Days until the project's own deadline, or null if it has none. */
  deadlineDays: number | null
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The single most pressing fact about a project, or null when there is nothing to
 * say. Ordered by what would actually make you open it: something is late, then
 * something is about to be late, then nothing has moved at all.
 *
 * A project that is finished, paused or dormant is in that state deliberately, so it
 * is never dragged back into view.
 */
export function attentionReason(input: AttentionInput): string | null {
  if (input.status !== 'active') return null

  if (input.overdueTasks > 0) {
    const oldest = input.worstOverdueDays > 0 ? `, oldest ${plural(input.worstOverdueDays, 'day')} past due` : ''
    return `${plural(input.overdueTasks, 'overdue item')}${oldest}`
  }

  if (input.deadlineDays !== null) {
    if (input.deadlineDays < 0) return `deadline passed ${plural(Math.abs(input.deadlineDays), 'day')} ago`
    if (input.deadlineDays <= THRESHOLDS.deadlineSoonDays) {
      const open = input.openTasks > 0 ? ` with ${plural(input.openTasks, 'item')} still open` : ''
      return input.deadlineDays === 0 ? 'the deadline is today' : `deadline in ${plural(input.deadlineDays, 'day')}${open}`
    }
  }

  if (input.daysSinceActivity >= THRESHOLDS.stillAfterDays) {
    return `standing still for ${plural(input.daysSinceActivity, 'day')}`
  }

  return null
}
