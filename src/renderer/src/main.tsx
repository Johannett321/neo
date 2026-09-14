import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles.css'

/**
 * Every query is an IPC call, and the main process is what talks to Neo Cloud — so
 * the main process is what decides whether the network is there, not the browser.
 *
 * React Query assumes a query is an HTTP request of its own and, by default, refuses
 * to run one while `navigator.onLine` is false: the fetch is *paused* rather than
 * failed, so it never resolves and never errors. Every screen reads `!data` as "not
 * here yet" and draws `Pending`, which is how a Mac with Wi-Fi switched on but joined
 * to nothing used to sit on `Loading…` for ever — and Chromium's idea of offline is
 * not Neo Cloud's anyway. With `always`, the call reaches the main process, which
 * either gets an answer or fails with one the app can show.
 *
 * `always` on mutations for the same reason and a sharper one: a paused mutation
 * looks like a task that was created and quietly was not.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      // Changes from other devices arrive as events, and a window coming back into
      // focus asks again, so nothing is kept stale on purpose.
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: false
    },
    mutations: { networkMode: 'always' }
  }
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
