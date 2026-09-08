import { useCallback, useEffect, useState } from 'react'
import { getJson, postJson } from '../api'
import { type SourceStatus, useEventStream } from '../useEventStream'

const SOURCES: Array<'screen' | 'mic' | 'system'> = ['screen', 'mic', 'system']

function dbToFraction(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

function ago(at?: number): string {
  if (!at) return '—'
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

function VuMeter({ label, db }: { label: string; db: number }) {
  return (
    <div className="vu">
      <span className="vu-label">{label}</span>
      <div className="vu-track">
        <div className="vu-fill" style={{ width: `${dbToFraction(db) * 100}%` }} />
      </div>
      <span className="vu-db">{db <= -100 ? '—' : `${Math.round(db)} dB`}</span>
    </div>
  )
}

function SourceRow({
  name,
  source,
  onToggle,
  busy,
}: {
  name: string
  source: SourceStatus | undefined
  onToggle?: (enabled: boolean) => void
  busy?: boolean
}) {
  const state = !source?.enabled ? 'disabled' : source.running ? 'running' : 'stopped'
  return (
    <div className="source-row">
      <span className={`dot ${state}`} />
      <span className="source-name">{name}</span>
      <span className="source-state">{state}</span>
      <span className="source-chunk">
        {source?.last_chunk_at ? `chunk ${ago(source.last_chunk_at)}` : ''}
      </span>
      {source?.last_error && <span className="source-error">{source.last_error}</span>}
      {onToggle ? (
        <label className="switch" title={`turn ${name} capture ${source?.enabled ? 'off' : 'on'}`}>
          <input
            type="checkbox"
            checked={source?.enabled === true}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="switch-track" />
        </label>
      ) : (
        <span />
      )}
    </div>
  )
}

export function StatusView() {
  const { status, levels, connected } = useEventStream()
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refreshLogs = useCallback(async () => {
    try {
      const res = await getJson<{ lines: string[] }>('/api/logs?n=200')
      setLogs(res.lines)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refreshLogs()
  }, [refreshLogs])

  // Audio switches write the config and restart a running daemon server-side;
  // the SSE status stream reports the new enabled/running state on its own.
  const toggleAudio = useCallback(async (source: 'mic' | 'system', enabled: boolean) => {
    setBusy(source)
    setError('')
    try {
      await postJson(`/api/capture/${source}`, { enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const control = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      setBusy(action)
      setError('')
      try {
        await postJson(`/api/daemon/${action}`, {})
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
        setTimeout(() => void refreshLogs(), 500)
      }
    },
    [refreshLogs],
  )

  const running = status?.running ?? false

  return (
    <div className="dashboard">
      <div className={`banner ${running ? 'ok' : 'warn'}`}>
        <strong>{running ? `Daemon running (pid ${status?.pid})` : 'Daemon stopped'}</strong>
        <span className="banner-conn">{connected ? 'live' : 'connecting…'}</span>
        <div className="banner-actions">
          <button
            type="button"
            disabled={running || busy !== null}
            onClick={() => control('start')}
          >
            Start
          </button>
          <button
            type="button"
            disabled={!running || busy !== null}
            onClick={() => control('stop')}
          >
            Stop
          </button>
          <button
            type="button"
            disabled={!running || busy !== null}
            onClick={() => control('restart')}
          >
            Restart
          </button>
        </div>
      </div>

      {error && <div className="error-line">{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h3>Sources</h3>
          <span className="panel-note">audio switches restart a running daemon</span>
        </div>
        {SOURCES.map((name) => (
          <SourceRow
            key={name}
            name={name}
            source={status?.sources?.[name]}
            busy={busy !== null}
            onToggle={
              name === 'screen'
                ? undefined
                : (enabled) => void toggleAudio(name as 'mic' | 'system', enabled)
            }
          />
        ))}
      </section>

      <section className="panel">
        <h3>Audio levels</h3>
        <VuMeter label="mic" db={levels.mic} />
        <VuMeter label="system" db={levels.system} />
      </section>

      {status?.focused_window && (
        <section className="panel">
          <h3>Focused window</h3>
          <div className="kv">
            <span>app</span>
            <span className="mono">{status.focused_window.app || '—'}</span>
            <span>title</span>
            <span className="mono">{status.focused_window.title || '—'}</span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>Logs</h3>
          <button type="button" onClick={() => void refreshLogs()}>
            Refresh
          </button>
        </div>
        <pre className="logs">{logs.length ? logs.join('\n') : '(no log output)'}</pre>
      </section>
    </div>
  )
}
