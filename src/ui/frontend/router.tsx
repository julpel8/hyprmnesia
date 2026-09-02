import { useMemo, useSyncExternalStore } from 'react'

export interface Route {
  path: string
  params: URLSearchParams
}

const DEFAULT_HASH = '#/replay'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function currentHash(): string {
  return window.location.hash || DEFAULT_HASH
}

// The raw hash string is a stable snapshot (required by useSyncExternalStore);
// the parsed Route is memoised from it.
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, () => DEFAULT_HASH)
  return useMemo(() => {
    const raw = hash.replace(/^#/, '') || '/replay'
    const qIndex = raw.indexOf('?')
    const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw
    const query = qIndex >= 0 ? raw.slice(qIndex + 1) : ''
    return { path: path || '/replay', params: new URLSearchParams(query) }
  }, [hash])
}

export function navigate(pathWithQuery: string): void {
  window.location.hash = pathWithQuery.startsWith('#') ? pathWithQuery : `#${pathWithQuery}`
}
