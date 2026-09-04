import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // The database is in-process; a request costs microseconds, so keep it fresh.
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: false
    }
  }
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
