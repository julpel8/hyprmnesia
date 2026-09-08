import { useCallback, useRef, useState } from 'react'
import { type CaptureEvent, useEventStream } from '../useEventStream'

interface TranscriptTake {
  id: string
  text: string
  engine: string
}

// One stretch of speech, with room for a second engine's take on it. Both
// engines segment the audio with the same settings, so a compare segment lands
// on the same start time as the primary one and the two are shown as one row.
interface TranscriptLine {
  at: number
  key: string
  startAt: number
  primary?: TranscriptTake
  compare?: TranscriptTake
}

type Transcripts = Record<'mic' | 'system', TranscriptLine[]>

const MAX_LINES = 200

function hhmmss(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

// hpm-asr reports engines as "family:model"; the family alone is the useful
// label once two of them sit side by side.
function engineLabel(engine: string): string {
  return engine.split(':')[0] || engine
}

function Take({ take }: { take?: TranscriptTake }) {
  return (
    <div className="transcript-take">
      <span className="transcript-engine">{take ? engineLabel(take.engine) : ''}</span>
      {take ? (
        <span className="transcript-text">{take.text}</span>
      ) : (
        <span className="transcript-text muted">(nothing here)</span>
      )}
    </div>
  )
}

function SourceColumn({
  label,
  lines,
  comparing,
}: {
  label: string
  lines: TranscriptLine[]
  comparing: boolean
}) {
  return (
    <div className="transcript-col">
      <h3>{label}</h3>
      {lines.length === 0 ? (
        <p className="muted">(waiting for transcription)</p>
      ) : (
        <div className="transcript-lines">
          {lines.map((line) => (
            <div className="transcript-line" key={line.key}>
              <span className="transcript-time">{hhmmss(line.at)}</span>
              <div className="transcript-takes">
                <Take take={line.primary} />
                {comparing && <Take take={line.compare} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LiveView() {
  const [transcripts, setTranscripts] = useState<Transcripts>({ mic: [], system: [] })
  const [asrStatus, setAsrStatus] = useState<Record<string, string>>({})
  const [comparing, setComparing] = useState(false)
  const seen = useRef(new Set<string>())

  const onCapture = useCallback((event: CaptureEvent) => {
    if (event.type === 'transcription_status') {
      const progress = typeof event.progress === 'number' ? ` (${Math.round(event.progress)}%)` : ''
      const message = event.message ? ` — ${String(event.message)}` : ''
      const engine = String(event.engine)
      setAsrStatus((prev) => ({
        ...prev,
        [engine]: `${String(event.status)}${message}${progress}`,
      }))
      return
    }
    // `transcription_segment` carries a unique segment id and a role, unlike the
    // older `transcribed` event which is keyed by chunk and only ever primary.
    if (event.type !== 'transcription_segment') return
    const source = event.source
    if (source !== 'mic' && source !== 'system') return
    const id = String(event.id)
    if (seen.current.has(id)) return
    seen.current.add(id)

    const isCompare = event.role === 'compare'
    if (isCompare) setComparing(true)
    const startAt = Number(event.start_at)
    const take: TranscriptTake = {
      id,
      text: String(event.text ?? ''),
      engine: String(event.engine ?? ''),
    }

    setTranscripts((prev) => {
      const lines = prev[source]
      // Only recent lines can still be waiting for their other half, so pair
      // against the tail rather than rescanning the whole column. The window is
      // generous because a slower second engine can run well behind the first.
      const from = Math.max(0, lines.length - 40)
      for (let index = lines.length - 1; index >= from; index--) {
        const line = lines[index]
        if (!line || line.startAt !== startAt) continue
        if (isCompare ? line.compare : line.primary) continue
        const merged = [...lines]
        merged[index] = isCompare ? { ...line, compare: take } : { ...line, primary: take }
        return { ...prev, [source]: merged }
      }
      const line: TranscriptLine = isCompare
        ? { at: event.at, key: id, startAt, compare: take }
        : { at: event.at, key: id, startAt, primary: take }
      return { ...prev, [source]: [...lines, line].slice(-MAX_LINES) }
    })
  }, [])

  const { status, connected } = useEventStream(onCapture)
  const daemonStopped = status !== null && !status.running

  return (
    <div className="live">
      <div className="live-head">
        <span className="banner-conn">{connected ? 'live' : 'connecting…'}</span>
        {Object.entries(asrStatus).map(([engine, text]) => (
          <span className="asr-status" key={engine}>
            {engine}: {text}
          </span>
        ))}
      </div>
      {daemonStopped && (
        <div className="banner warn">
          <strong>Daemon stopped</strong>
          <span>Start it from the Dashboard to see live transcription.</span>
        </div>
      )}
      <div className="transcript-grid">
        <SourceColumn label="Mic" lines={transcripts.mic} comparing={comparing} />
        <SourceColumn label="System" lines={transcripts.system} comparing={comparing} />
      </div>
    </div>
  )
}
