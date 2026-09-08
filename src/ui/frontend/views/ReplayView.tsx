import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson, postJson } from '../api'
import { navigate } from '../router'
import type { ReplayBounds, ReplayChunk, ReplayHost, ReplayManifest } from '../types'
import { ReplayAudioEngine } from './replayAudio'

const SUPPRESSION_TTL_MS = 8_000
const SUPPRESSION_RENEW_MS = 3_000

function fmt(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  const total = Math.floor(clamped / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function toLocalInput(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fromLocalInput(value: string): number {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : NaN
}

function parseTimeParam(value: string | null): number {
  if (!value) return NaN
  const numeric = Number(value)
  if (Number.isFinite(numeric) && value.trim() !== '') return numeric
  return Date.parse(value)
}

// hpm-asr reports engines as "family:model"; the family alone is enough to tell
// two transcripts of the same speech apart.
function engineLabel(engine: string): string {
  return engine.split(':')[0] || engine
}

function activeByStart(items: ReplayChunk[], ms: number): ReplayChunk | null {
  let active: ReplayChunk | null = null
  for (const item of items) {
    if (item.offset_start_ms <= ms) active = item
    else break
  }
  return active
}

export function ReplayView({ params }: { params: URLSearchParams }) {
  const [preset, setPreset] = useState('last-15')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false })
  const [rangeMeta, setRangeMeta] = useState('')
  const [manifest, setManifest] = useState<ReplayManifest | null>(null)
  const [displayMs, setDisplayMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState('1')
  const [system, setSystem] = useState(true)
  const [mic, setMic] = useState(false)
  const [suppress, setSuppress] = useState(true)
  const [subs, setSubs] = useState(true)
  const [showContext, setShowContext] = useState(true)
  const [showOcr, setShowOcr] = useState(true)
  // Replay shows one machine at a time: two machines' screens on a single
  // timeline would show neither. Empty string means this machine.
  const [hosts, setHosts] = useState<ReplayHost[]>([])
  const [host, setHost] = useState(params.get('host') ?? '')

  // Authoritative playback state for the audio clock / rAF loop, mirrored from
  // React state each render so async engine callbacks read the latest values.
  const currentMsRef = useRef(0)
  const playingRef = useRef(false)
  const manifestRef = useRef<ReplayManifest | null>(null)
  const speedRef = useRef('1')
  const systemRef = useRef(true)
  const micRef = useRef(false)
  const suppressRef = useRef(true)
  const lastFrameRef = useRef(0)
  const suppressionTimerRef = useRef<number | undefined>(undefined)
  const boundsRef = useRef<ReplayBounds | null>(null)
  const hostRef = useRef('')
  const engineRef = useRef<ReplayAudioEngine | null>(null)

  manifestRef.current = manifest
  playingRef.current = playing
  speedRef.current = speed
  systemRef.current = system
  micRef.current = mic
  suppressRef.current = suppress
  hostRef.current = host

  if (!engineRef.current) {
    engineRef.current = new ReplayAudioEngine({
      manifest: () => manifestRef.current,
      currentMs: () => currentMsRef.current,
      playing: () => playingRef.current,
      speed: () => Number(speedRef.current) || 1,
      enabled: (source) => (source === 'system' ? systemRef.current : micRef.current),
    })
  }

  const syncAudio = useCallback(() => engineRef.current?.sync(), [])

  const wantsSuppressed = useCallback(
    () => playingRef.current && suppressRef.current && (systemRef.current || micRef.current),
    [],
  )

  const postSuppression = useCallback((active: boolean, keepalive = false) => {
    void postJson(
      '/api/replay-transcription',
      { active, ttl_ms: SUPPRESSION_TTL_MS },
      { keepalive },
    )
  }, [])

  const updateSuppression = useCallback(() => {
    if (suppressionTimerRef.current) {
      clearInterval(suppressionTimerRef.current)
      suppressionTimerRef.current = undefined
    }
    if (!wantsSuppressed()) {
      postSuppression(false)
      return
    }
    postSuppression(true)
    suppressionTimerRef.current = window.setInterval(() => {
      if (wantsSuppressed()) postSuppression(true)
      else updateSuppression()
    }, SUPPRESSION_RENEW_MS)
  }, [wantsSuppressed, postSuppression])

  const clearSuppression = useCallback(
    (keepalive = false) => {
      if (suppressionTimerRef.current) {
        clearInterval(suppressionTimerRef.current)
        suppressionTimerRef.current = undefined
      }
      postSuppression(false, keepalive)
    },
    [postSuppression],
  )

  const pause = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    clearSuppression()
    engineRef.current?.stop()
  }, [clearSuppression])

  const play = useCallback(() => {
    const m = manifestRef.current
    if (!m || m.duration_ms <= 0) return
    if (currentMsRef.current >= m.duration_ms) {
      currentMsRef.current = 0
      setDisplayMs(0)
    }
    playingRef.current = true
    setPlaying(true)
    lastFrameRef.current = performance.now()
    updateSuppression()
    syncAudio()
  }, [updateSuppression, syncAudio])

  // Jump the playhead; resets audio scheduling and suppression, like the
  // original seek/skip handlers.
  const seekTo = useCallback(
    (ms: number) => {
      const m = manifestRef.current
      const clamped = m ? Math.max(0, Math.min(ms, m.duration_ms)) : Math.max(0, ms)
      currentMsRef.current = clamped
      setDisplayMs(clamped)
      lastFrameRef.current = performance.now()
      engineRef.current?.reset()
      updateSuppression()
      syncAudio()
    },
    [updateSuppression, syncAudio],
  )

  const setRangeFields = useCallback((from: number, to: number) => {
    setFromInput(toLocalInput(from))
    setToInput(toLocalInput(to))
  }, [])

  const applyPreset = useCallback(
    (value: string) => {
      const now = Date.now()
      if (value === 'custom') return
      if (value === 'today') {
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        setRangeFields(start.getTime(), now)
        return
      }
      const minutes = Number(value.replace('last-', ''))
      if (Number.isFinite(minutes)) setRangeFields(now - minutes * 60_000, now)
    },
    [setRangeFields],
  )

  const loadManifest = useCallback(
    async (fromMs: number, toMs: number) => {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        setStatus({ text: 'Choose a valid from/to range', error: true })
        return
      }
      if (toMs < fromMs) {
        setStatus({ text: 'End must be after start', error: true })
        return
      }
      pause()
      setManifest(null)
      manifestRef.current = null
      currentMsRef.current = 0
      setDisplayMs(0)
      setStatus({ text: 'Loading replay…', error: false })
      const from = Math.trunc(fromMs)
      const to = Math.trunc(toMs)
      try {
        const hostQuery = hostRef.current ? `&host=${encodeURIComponent(hostRef.current)}` : ''
        const loaded = await getJson<ReplayManifest>(
          `/api/manifest?from=${from}&to=${to}${hostQuery}`,
        )
        setManifest(loaded)
        manifestRef.current = loaded
        currentMsRef.current = 0
        setDisplayMs(0)
        setRangeMeta(`${loaded.local_from} to ${loaded.local_to} (${loaded.timezone})`)
        navigate(`/replay?from=${from}&to=${to}${hostQuery}`)
        setStatus({
          text: `Loaded ${loaded.screenshots.length} screenshots, ${loaded.audio.system.length} system chunks, ${loaded.audio.mic.length} mic chunks, ${loaded.segments.length} subtitles`,
          error: false,
        })
      } catch (err) {
        setStatus({ text: err instanceof Error ? err.message : String(err), error: true })
      }
    },
    [pause],
  )

  // Bounds are per machine: switching machines changes what range has data.
  const loadBounds = useCallback(async (hostId: string) => {
    const query = hostId ? `?host=${encodeURIComponent(hostId)}` : ''
    const bounds = await getJson<ReplayBounds>(`/api/range${query}`)
    boundsRef.current = bounds
    if (bounds.from === null || bounds.to === null) {
      setStatus({ text: 'No captured data yet', error: true })
    } else {
      setStatus({
        text: `Captured range: ${bounds.local_from} to ${bounds.local_to}`,
        error: false,
      })
    }
    return bounds
  }, [])

  const onHostChange = useCallback(
    (value: string) => {
      setHost(value)
      hostRef.current = value
      setManifest(null)
      manifestRef.current = null
      ;(async () => {
        try {
          await loadBounds(value)
          await loadManifest(fromLocalInput(fromInput), fromLocalInput(toInput))
        } catch (err) {
          setStatus({ text: err instanceof Error ? err.message : String(err), error: true })
        }
      })()
    },
    [loadBounds, loadManifest, fromInput, toInput],
  )

  const onLoadClick = useCallback(() => {
    void loadManifest(fromLocalInput(fromInput), fromLocalInput(toInput))
  }, [loadManifest, fromInput, toInput])

  // Boot: load capture bounds, then honour a from/to deep-link or apply the
  // default preset. Runs once.
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    ;(async () => {
      try {
        try {
          const list = await getJson<ReplayHost[]>('/api/hosts')
          setHosts(list)
          // The picker needs a value that matches an option, and an absent
          // `host` param means this machine.
          if (!hostRef.current) {
            const local = list.find((entry) => entry.is_local) ?? list[0]
            if (local) {
              hostRef.current = local.host_id
              setHost(local.host_id)
            }
          }
        } catch {
          // An older daemon has no /api/hosts. Replay still works on this machine.
        }
        const bounds = await loadBounds(hostRef.current)
        const initialFrom = parseTimeParam(params.get('from'))
        const initialTo = parseTimeParam(params.get('to'))
        if (Number.isFinite(initialFrom) && Number.isFinite(initialTo)) {
          setPreset('custom')
          setRangeFields(initialFrom, initialTo)
          await loadManifest(initialFrom, initialTo)
        } else if (bounds.to !== null) {
          applyPreset(preset)
        }
      } catch (err) {
        setStatus({ text: err instanceof Error ? err.message : String(err), error: true })
      }
    })()
  }, [])

  // rAF playback loop + keyboard shortcuts + unload cleanup. Runs once.
  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      if (playingRef.current) {
        const m = manifestRef.current
        currentMsRef.current += (now - lastFrameRef.current) * (Number(speedRef.current) || 1)
        lastFrameRef.current = now
        if (m && currentMsRef.current >= m.duration_ms) {
          currentMsRef.current = m.duration_ms
          pause()
        }
        setDisplayMs(currentMsRef.current)
        syncAudio()
      }
      raf = requestAnimationFrame(tick)
    }
    lastFrameRef.current = performance.now()
    raf = requestAnimationFrame(tick)

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'BUTTON'].includes(target.tagName)) return
      if (event.key === ' ') {
        event.preventDefault()
        if (playingRef.current) pause()
        else play()
      } else if (event.key === 'ArrowLeft') {
        seekTo(currentMsRef.current - (event.shiftKey ? 30_000 : 5_000))
      } else if (event.key === 'ArrowRight') {
        seekTo(currentMsRef.current + (event.shiftKey ? 30_000 : 5_000))
      }
    }
    const onUnload = () => clearSuppression(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      clearSuppression(true)
    }
  }, [pause, play, seekTo, syncAudio, clearSuppression])

  // Track/speed changes must re-plan audio while playing.
  const onPlaybackInputChange = useCallback(() => {
    engineRef.current?.reset()
    updateSuppression()
    syncAudio()
  }, [updateSuppression, syncAudio])

  const screen = manifest ? activeByStart(manifest.screenshots, displayMs) : null
  const comparedSegments = Boolean(manifest?.segments.some((segment) => segment.role === 'compare'))
  const activeSubtitles =
    manifest && subs
      ? manifest.segments
          .filter(
            (segment) =>
              segment.offset_start_ms <= displayMs &&
              segment.offset_end_ms >= displayMs &&
              segment.text.trim(),
          )
          // Two engines transcribing the same speech produce two segments with
          // the same start; the primary one always reads first.
          .sort(
            (a, b) =>
              a.offset_start_ms - b.offset_start_ms ||
              Number(a.role === 'compare') - Number(b.role === 'compare'),
          )
      : []

  const emptyText = !manifest
    ? boundsRef.current && boundsRef.current.from === null
      ? 'No captured data yet'
      : 'Choose a replay range'
    : manifest.screenshots.length
      ? 'Screenshot blob missing'
      : 'No screenshots in range'

  return (
    <div className="replay">
      <section className="picker">
        {hosts.length > 1 ? (
          <label>
            Machine
            <select value={host} onChange={(e) => onHostChange(e.target.value)}>
              {hosts.map((entry) => (
                <option key={entry.host_id} value={entry.host_id}>
                  {entry.is_local ? `${entry.host_id || 'local'} (this machine)` : entry.host_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Range
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value)
              applyPreset(e.target.value)
            }}
          >
            <option value="last-5">Last 5 min</option>
            <option value="last-15">Last 15 min</option>
            <option value="last-30">Last 30 min</option>
            <option value="last-60">Last hour</option>
            <option value="today">Today</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          From
          <input
            type="datetime-local"
            step={1}
            value={fromInput}
            onChange={(e) => {
              setFromInput(e.target.value)
              setPreset('custom')
            }}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            step={1}
            value={toInput}
            onChange={(e) => {
              setToInput(e.target.value)
              setPreset('custom')
            }}
          />
        </label>
        <button type="button" onClick={onLoadClick}>
          Load Replay
        </button>
        <span
          className="picker-status"
          style={{ color: status.error ? 'var(--warn)' : 'var(--muted)' }}
        >
          {status.text}
        </span>
      </section>

      <div className="replay-body">
        <section className="stage">
          {screen?.blob_url ? (
            <img src={screen.blob_url} alt="Replay screenshot" />
          ) : (
            <div className="empty">{emptyText}</div>
          )}
          <div className="subtitles">
            {activeSubtitles.map((segment) => (
              <div
                className={segment.role === 'compare' ? 'subtitle compare' : 'subtitle'}
                key={segment.id}
              >
                <b>{segment.source}</b>
                {/* Only worth naming the engine when a second one recorded the
                    same speech; on its own the primary transcript is just the
                    transcript. */}
                {comparedSegments && <i>{engineLabel(segment.engine)}</i>}
                {segment.text}
              </div>
            ))}
          </div>
        </section>

        <aside>
          <h1>Replay</h1>
          <div className="meta">{rangeMeta}</div>
          {showContext && (
            <div className="section">
              <strong>Context</strong>
              <div className="kv">
                {screen ? (
                  <>
                    <span>time</span>
                    <span className="mono">{screen.local_at || '-'}</span>
                    <span>app</span>
                    <span className="mono">{screen.window.app || '-'}</span>
                    <span>title</span>
                    <span className="mono">{screen.window.title || '-'}</span>
                    <span>url</span>
                    <span className="mono">{screen.window.url || '-'}</span>
                    <span>chunk</span>
                    <span className="mono">{screen.id}</span>
                  </>
                ) : (
                  <>
                    <span>state</span>
                    <span>no screenshot</span>
                  </>
                )}
              </div>
            </div>
          )}
          {showOcr && (
            <div className="section">
              <strong>OCR</strong>
              <div className="ocr">{screen?.text || ''}</div>
            </div>
          )}
        </aside>
      </div>

      <section className="controls">
        <div className="left">
          <button type="button" className="play" onClick={() => (playing ? pause() : play())}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="time">
            {fmt(displayMs)} / {fmt(manifest?.duration_ms ?? 0)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={manifest?.duration_ms ?? 0}
          value={Math.floor(displayMs)}
          step={50}
          onChange={(e) => seekTo(Number(e.target.value))}
        />
        <div className="right">
          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(e) => {
              setSpeed(e.target.value)
              onPlaybackInputChange()
            }}
          >
            <option value="0.5">0.5x</option>
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={system}
              onChange={(e) => {
                setSystem(e.target.checked)
                systemRef.current = e.target.checked
                onPlaybackInputChange()
              }}
            />{' '}
            <strong>system</strong>
          </label>
          <label>
            <input
              type="checkbox"
              checked={mic}
              onChange={(e) => {
                setMic(e.target.checked)
                micRef.current = e.target.checked
                onPlaybackInputChange()
              }}
            />{' '}
            mic
          </label>
          <label>
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => {
                setSuppress(e.target.checked)
                suppressRef.current = e.target.checked
                updateSuppression()
              }}
            />{' '}
            no re-transcribe
          </label>
          <label>
            <input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} />{' '}
            subtitles
          </label>
          <label>
            <input
              type="checkbox"
              checked={showContext}
              onChange={(e) => setShowContext(e.target.checked)}
            />{' '}
            context
          </label>
          <label>
            <input
              type="checkbox"
              checked={showOcr}
              onChange={(e) => setShowOcr(e.target.checked)}
            />{' '}
            OCR
          </label>
        </div>
      </section>
    </div>
  )
}
