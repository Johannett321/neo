import { useEffect, useState } from 'react'

/**
 * The wall clock, ticking on the minute.
 *
 * Timed to the *next* minute rather than every sixty seconds from whenever the
 * component happened to mount, so the digits change when the minute does. A clock
 * that turns over eleven seconds late is a clock you stop believing.
 */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      const at = new Date()
      setNow(at)
      timer = setTimeout(tick, 60_000 - (at.getSeconds() * 1000 + at.getMilliseconds()))
    }
    timer = setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()))
    return () => clearTimeout(timer)
    // Once. The timeout re-arms itself, and depending on `now` would rebuild the
    // chain on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return now
}

/**
 * Morning, afternoon, evening — and nothing cleverer.
 *
 * The tempting version comments on the hour: "still up", "working late". It reads as
 * a remark about your life the third time you see it at eleven at night, and this is
 * a screen you open every day.
 */
export function greeting(at: Date = new Date()): string {
  const hour = at.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}
