import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles.css'

/**
 * Nothing this app reads or writes goes over a network, so nothing here is allowed
 * to wait for one.
 *
 * React Query assumes a query is an HTTP request and, by default, refuses to run one
 * while `navigator.onLine` is false — the fetch is *paused* rather than failed, so it
 * never resolves and never errors. Every screen here reads `!data` as "not here yet"
 * and draws `Pending`, which is why a Mac with Wi-Fi switched on but joined to
 * nothing used to open a project and sit on `Loading…` for ever, and why a launch in
 * that state never got past the splash at all. The queries are IPC calls to a
 * PostgreSQL database in `~/.neo`; being off a network has no bearing on any of them.
 *
 * `always` on mutations for the same reason and a sharper one: a paused mutation
 * looks like a task that was created and quietly was not.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      // The database is in-process; a request costs microseconds, so keep it fresh.
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
