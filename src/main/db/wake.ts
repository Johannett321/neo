/**
 * "This device just wrote something."
 *
 * A listener rather than a call, and that is what keeps the database from knowing
 * there is a network. With nothing attached — Local — the set is empty and a write
 * ends where it always did. With the sync engine attached it is what turns a change
 * on this Mac into a push in under a second instead of on the next minute's poll,
 * which is most of what "near instant" actually means.
 */

type WriteListener = () => void

const listeners = new Set<WriteListener>()

export function onLocalWrite(listener: WriteListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function announceWrite(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A transport that throws on being nudged must not fail the write that nudged
      // it. The work is recorded; getting it off the machine can wait.
    }
  }
}
