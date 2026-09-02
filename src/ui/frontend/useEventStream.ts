import { useEffect, useRef, useState } from 'react'

export interface SourceStatus {
  enabled: boolean
  running: boolean
  started_at?: number
  last_chunk_at?: number
  last_chunk_bytes?: number
  last_error?: string
}

export interface DaemonStatus {
  running: boolean
  pid: number | null
  logs: string
  errors: string
  levels: { mic: number; system: number }
  sources: Record<'screen' | 'mic' | 'system', SourceStatus>
  focused_window?: { app?: string | null; title?: string | null; url?: string | null }
}

// Capture events are a wide union; views narrow by `type` and cast fields.
export type CaptureEvent = { type: string; at: number; [key: string]: unknown }

// Opens the /api/events SSE stream (cookie-authorized, same-origin) and exposes
// the latest status/levels as state while forwarding capture events to a
// callback. One stream per mounted view; closed on unmount.
export function useEventStream(onCapture?: (event: CaptureEvent) => void): {
  status: DaemonStatus | null
  levels: { mic: number; system: number }
  connected: boolean
} {
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [levels, setLevels] = useState({ mic: -100, system: -100 })
  const [connected, setConnected] = useState(false)
  const captureRef = useRef(onCapture)
  captureRef.current = onCapture

  useEffect(() => {
    const source = new EventSource('/api/events')
    source.addEventListener('open', () => setConnected(true))
    source.addEventListener('error', () => setConnected(false))
    source.addEventListener('status', (e) => setStatus(JSON.parse(e.data) as DaemonStatus))
    source.addEventListener('levels', (e) =>
      setLevels(JSON.parse(e.data) as { mic: number; system: number }),
    )
    source.addEventListener('capture', (e) => captureRef.current?.(JSON.parse(e.data)))
    return () => source.close()
  }, [])

  return { status, levels, connected }
}
