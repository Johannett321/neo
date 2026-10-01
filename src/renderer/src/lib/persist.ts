import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query'

/**
 * The window's data, kept on disk so it can be drawn again without Neo Cloud.
 *
 * The query cache is handed to main whenever it settles (`cache:save`), which seals it
 * per account in the user-data folder (`main/lib/cloud/cache.ts`), and read back once
 * before the first render (`cache:load`). Online, the copy is only ever a first frame:
 * every query is stale on arrival and asks Neo Cloud again at once. Offline, it is what
 * there is to read, and the screens draw it rather than an apology.
 *
 * Left out: who is signed in (asked fresh every launch), and the things that are not
 * the work — conversations with the assistant (they live with the assistant, which
 * cannot run offline anyway), transcripts, search results, the updater, the weather.
 */

const SKIPPED = new Set([
  'account:status', 'account:devices', 'chat:list', 'chat:get', 'recording:get', 'search:query',
  'weather:get', 'weather:search', 'update:status', 'update:capability', 'changelog:list', 'changelog:get',
  'permission:read', 'systemAudio:available', 'notification:capability', 'notification:pending',
  'claude:status', 'profile:suggestName', 'sync:state'
])

/** Long enough that a burst of writes is one save; short enough that a quit loses nothing worth having. */
const SETTLE_MS = 1_500

export async function restoreCache(client: QueryClient): Promise<boolean> {
  try {
    const saved = await window.api.invoke('cache:load')
    if (!saved) return false
    hydrate(client, saved.state as Parameters<typeof hydrate>[1])
    return true
  } catch {
    return false
  }
}

const snapshot = (client: QueryClient): unknown =>
  dehydrate(client, {
    shouldDehydrateQuery: (query) =>
      query.state.status !== 'pending' &&
      query.state.data !== undefined &&
      !SKIPPED.has(String(query.queryKey[0]))
  })

/** Save whenever the cache changes, a moment after it stops changing. Returns a stop function. */
export function persistCache(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    timer = null
    void window.api.invoke('cache:save', { state: snapshot(client) }).catch(() => {})
  }
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SETTLE_MS)
  })
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      save()
    }
  }
  window.addEventListener('beforeunload', flush)
  return () => {
    stop()
    window.removeEventListener('beforeunload', flush)
  }
}
