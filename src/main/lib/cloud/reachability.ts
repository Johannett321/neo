/**
 * Whether Neo Cloud answered the last time anything asked it.
 *
 * Not the operating system's idea of being online — a Mac joined to a hotel's Wi-Fi
 * is online and still cannot reach anything. Every request through `client.ts` says
 * how it went, and so does the event stream; the outbox listens, and sends what is
 * waiting the moment the answer turns to yes.
 */

type Listener = (reachable: boolean) => void

let reachable = true
const listeners = new Set<Listener>()

export const isReachable = (): boolean => reachable

export function setReachable(next: boolean): void {
  if (next === reachable) return
  reachable = next
  for (const listener of [...listeners]) listener(next)
}

export function onReachability(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
