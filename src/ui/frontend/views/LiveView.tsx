import { useCallback, useRef, useState } from 'react'
import { type CaptureEvent, useEventStream } from '../useEventStream'

interface TranscriptLine {
  at: number
  id: string
  text: string
  engine: string
}

type Transcripts = Record<'mic' | 'system', TranscriptLine[]>

const MAX_LINES = 200

function hhmmss(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

function SourceColumn({ label, lines }: { label: string; lines: TranscriptLine[] }) {
  return (
    <div className="transcript-col">
      <h3>{label}</h3>
      {lines.length === 0 ? (
        <p className="muted">(waiting for transcription)</p>
      ) : (
        <div className="transcript-lines">
          {lines.map((line) => (
            <div className="transcript-line" key={line.id}>
              <span className="transcript-time">{hhmmss(line.at)}</span>
              <span className="transcript-engine">{line.engine}</span>
              <span className="transcript-text">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LiveView() {
  const [transcripts, setTranscripts] = useState<Transcripts>({ mic: [], system: [] })
  const [asrStatus, setAsrStatus] = useState('')
  const seen = useRef(new Set<string>())

  const onCapture = useCallback((event: CaptureEvent) => {
    if (event.type === 'transcription_status') {
      const progress = typeof event.progress === 'number' ? ` (${Math.round(event.progress)}%)` : ''
      const message = event.message ? ` — ${String(event.message)}` : ''
      setAsrStatus(`${String(event.engine)}: ${String(event.status)}${message}${progress}`)
      return
    }
    if (event.type === 'transcribed') {
      const source = event.source
      if (source !== 'mic' && source !== 'system') return
      const id = String(event.id)
      if (seen.current.has(id)) return
      seen.current.add(id)
      const line: TranscriptLine = {
        at: event.at,
        id,
        text: String(event.text ?? ''),
        engine: String(event.engine ?? ''),
      }
      setTranscripts((prev) => ({
        ...prev,
        [source]: [...prev[source], line].slice(-MAX_LINES),
      }))
    }
  }, [])

  const { status, connected } = useEventStream(onCapture)
  const daemonStopped = status !== null && !status.running

  return (
    <div className="live">
      <div className="live-head">
        <span className="banner-conn">{connected ? 'live' : 'connecting…'}</span>
        {asrStatus && <span className="asr-status">{asrStatus}</span>}
      </div>
      {daemonStopped && (
        <div className="banner warn">
          <strong>Daemon stopped</strong>
          <span>Start it from the Dashboard to see live transcription.</span>
        </div>
      )}
      <div className="transcript-grid">
        <SourceColumn label="Mic" lines={transcripts.mic} />
        <SourceColumn label="System" lines={transcripts.system} />
      </div>
    </div>
  )
}
