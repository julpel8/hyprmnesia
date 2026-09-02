import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// Boot: the server may hand us a replay deep-link as query params. Translate a
// from/to deep-link into the hash route, then strip the query so nothing leaks
// into history or later navigation.
function boot(): void {
  const search = new URLSearchParams(window.location.search)

  const from = search.get('from')
  const to = search.get('to')
  if (from && to && !window.location.hash) {
    window.location.hash = `#/replay?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  }

  if (search.toString()) {
    const cleaned = window.location.pathname + window.location.hash
    window.history.replaceState(null, '', cleaned)
  }
}

boot()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
