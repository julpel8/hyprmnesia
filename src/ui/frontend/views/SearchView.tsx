import { useCallback, useState } from 'react'
import { getJson } from '../api'
import { navigate } from '../router'
import type { SearchResult } from '../types'

const SOURCES = ['', 'screen', 'mic', 'system'] as const

// A hit maps to a short replay window centred on it.
const REPLAY_PAD_MS = 15_000

function openInReplay(result: SearchResult): void {
  const from = Math.trunc(result.time - REPLAY_PAD_MS)
  const to = Math.trunc((result.end_time ?? result.time) + REPLAY_PAD_MS)
  navigate(`/replay?from=${from}&to=${to}`)
}

export function SearchView() {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [app, setApp] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setStatus('Enter a search query')
      return
    }
    setBusy(true)
    setStatus('Searching…')
    const params = new URLSearchParams({ q: query, limit: '50' })
    if (source) params.set('source', source)
    if (app.trim()) params.set('app', app.trim())
    try {
      const res = await getJson<{ results: SearchResult[] }>(`/api/search?${params.toString()}`)
      setResults(res.results)
      setStatus(res.results.length ? `${res.results.length} results` : 'No matches')
    } catch (err) {
      setResults(null)
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [query, source, app])

  return (
    <div className="search">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void runSearch()
        }}
      >
        <input
          type="search"
          placeholder="Search transcripts and screen text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          {SOURCES.map((s) => (
            <option key={s || 'all'} value={s}>
              {s || 'all sources'}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="app filter"
          value={app}
          onChange={(e) => setApp(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Search
        </button>
      </form>

      <div className="search-status">{status}</div>

      <div className="search-results">
        {results?.map((result) => (
          <button
            type="button"
            className="search-hit"
            key={`${result.type}:${result.id}`}
            onClick={() => openInReplay(result)}
          >
            {result.source === 'screen' && (
              <img
                className="hit-thumb"
                src={`/media/${encodeURIComponent(result.chunk_id)}`}
                alt=""
              />
            )}
            <div className="hit-body">
              <div className="hit-meta">
                <span className="hit-source">{result.source}</span>
                <span className="hit-time">{result.local_time}</span>
                {result.window.app && <span className="hit-app">{result.window.app}</span>}
              </div>
              <div className="hit-snippet">{result.snippet || '(no preview)'}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
