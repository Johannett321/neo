/**
 * A hybrid logical clock.
 *
 * Two Macs will disagree about the time, and one of them will have been asleep. Wall
 * clocks are therefore not an ordering, and "whichever row has the later timestamp
 * wins" quietly loses whole afternoons of work when a laptop's clock is a minute
 * behind. An HLC keeps a physical component so the order still means roughly
 * *when*, and a counter so that two events in the same millisecond — or a clock that
 * has gone backwards — still order deterministically. The device id is the final
 * tiebreak, which is what makes the total order identical on every machine.
 *
 * Encoded so that a plain string comparison is the order: fixed-width fields, most
 * significant first. That matters more than it looks — it means Postgres can sort
 * and compare these with no function, and the jsonb of per-field stamps in
 * `sync_row` can be compared with `>` in JavaScript without parsing anything.
 */

const MS_WIDTH = 15
const COUNTER_WIDTH = 5
const MAX_COUNTER = 99_999

let physical = 0
let counter = 0
let device = '0'

export function setDevice(id: string): void {
  device = id
}

/** Seed from the highest stamp already on disk, so a restart never repeats one. */
export function seed(highest: string | null): void {
  if (!highest) return
  const [ms, count] = highest.split('.')
  const seenMs = Number(ms)
  if (!Number.isFinite(seenMs)) return
  if (seenMs > physical) {
    physical = seenMs
    counter = Number(count) || 0
  }
}

/** The next stamp for something happening here, now. */
export function tick(): string {
  const wall = Date.now()
  if (wall > physical) {
    physical = wall
    counter = 0
  } else {
    // The clock has not moved, or has gone backwards. Neither is a reason to issue a
    // stamp that sorts before one already given out.
    counter += 1
    if (counter > MAX_COUNTER) {
      physical += 1
      counter = 0
    }
  }
  return format(physical, counter, device)
}

/**
 * Take account of a stamp that arrived from somewhere else.
 *
 * Called for every incoming op, before it is applied. Without this a device that has
 * been offline for a week would issue stamps that sort *before* everything it has
 * just received, and its next edit would silently lose to a week-old one.
 */
export function observe(remote: string): void {
  const [ms, count] = remote.split('.')
  const remoteMs = Number(ms)
  const remoteCounter = Number(count)
  if (!Number.isFinite(remoteMs)) return

  const wall = Date.now()
  const highest = Math.max(physical, remoteMs, wall)

  if (highest === physical && highest === remoteMs) {
    counter = Math.max(counter, remoteCounter || 0) + 1
  } else if (highest === physical) {
    counter += 1
  } else if (highest === remoteMs) {
    counter = (remoteCounter || 0) + 1
  } else {
    counter = 0
  }
  physical = highest
}

function format(ms: number, count: number, id: string): string {
  return `${String(ms).padStart(MS_WIDTH, '0')}.${String(count).padStart(COUNTER_WIDTH, '0')}.${id}`
}

/** Later wins. A missing stamp is older than any real one. */
export const isNewer = (a: string, b: string | undefined | null): boolean => !b || a > b
