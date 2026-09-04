import type { Health } from '@shared/types'

/**
 * Health is derived, never self-reported. A status you have to remember to update
 * is a status that is always wrong, and a colour with no explanation is decoration.
 * Every level here comes with the reasons that produced it, which the UI shows on hover.
 */
export const THRESHOLDS = {
  /** An active project untouched for this long is drifting. */
  staleAfterDays: 21,
  /** A project deadline starts mattering this far out. */
  deadlineSoonDays: 14,
  /** Overdue by this much stops being a slip and starts being a problem. */
  badlyOverdueDays: 7,
  /** How many overdue items tips a project into risk on volume alone. */
  overdueCountForRisk: 3
} as const

export interface HealthInput {
  status: string
  daysSinceActivity: number
  openTasks: number
  overdueTasks: number
  /** Days past due for the oldest overdue item. */
  worstOverdueDays: number
  /** Days until the project's own deadline, or null if it has none. */
  deadlineDays: number | null
  hasNextAction: boolean
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function computeHealth(input: HealthInput): Health {
  const reasons: string[] = []
  let level: Health['level'] = 'good'

  if (input.status === 'done') return { level: 'good', reasons: ['Closed out'] }
  if (input.status === 'paused') return { level: 'idle', reasons: ['Paused on purpose'] }

  const escalate = (next: Health['level']): void => {
    const order: Health['level'][] = ['good', 'idle', 'watch', 'risk']
    if (order.indexOf(next) > order.indexOf(level)) level = next
  }

  if (input.overdueTasks > 0) {
    reasons.push(
      `${plural(input.overdueTasks, 'overdue task')}, oldest ${plural(input.worstOverdueDays, 'day')} past due`
    )
    escalate(
      input.worstOverdueDays >= THRESHOLDS.badlyOverdueDays ||
        input.overdueTasks >= THRESHOLDS.overdueCountForRisk
        ? 'risk'
        : 'watch'
    )
  }

  if (input.deadlineDays !== null) {
    if (input.deadlineDays < 0) {
      reasons.push(`deadline passed ${plural(Math.abs(input.deadlineDays), 'day')} ago`)
      escalate('risk')
    } else if (input.deadlineDays <= THRESHOLDS.deadlineSoonDays) {
      reasons.push(
        input.deadlineDays === 0
          ? 'the deadline is today'
          : `deadline in ${plural(input.deadlineDays, 'day')}` +
            (input.openTasks > 0 ? ` with ${plural(input.openTasks, 'task')} still open` : '')
      )
      escalate(input.deadlineDays <= 3 && input.openTasks > 0 ? 'risk' : 'watch')
    }
  }

  if (input.status === 'active' && input.daysSinceActivity >= THRESHOLDS.staleAfterDays) {
    reasons.push(`no activity for ${plural(input.daysSinceActivity, 'day')}`)
    escalate(level === 'good' ? 'idle' : level)
  }

  if (input.status === 'dormant') {
    reasons.push('Dormant')
    escalate('idle')
  }

  if (!input.hasNextAction && input.status === 'active' && input.openTasks === 0) {
    reasons.push('no next action defined')
    escalate('watch')
  }

  if (reasons.length === 0) reasons.push('Nothing overdue, nothing stalled')
  return { level, reasons }
}

export const HEALTH_LABEL: Record<Health['level'], string> = {
  good: 'On track',
  watch: 'Watch',
  risk: 'At risk',
  idle: 'Idle'
}
