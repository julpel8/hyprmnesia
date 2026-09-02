// Server-Sent Events stream multiplexing three channels onto one connection:
//   - `capture`: CaptureEvents from the daemon log (started/stopped/chunk/
//     transcribed/transcription_segment/window_changed/error/log/…)
//   - `levels`:  mic/system RMS at 10 Hz for the vu-meters
//   - `status`:  the daemon status payload, initial + every 2s
// The orchestrator's synthesised audio_level events are dropped here since
// levels have their own channel. Timers and the subscription are torn down when
// the client disconnects (stream cancel).

import { readLevels } from '../../core/daemon'
import type { Orchestrator } from '../../core/orchestrator'
import { statusPayload } from './daemon'

export interface EventsContext {
  orchestrator: Orchestrator
  headers: (extra?: Record<string, string>) => Record<string, string>
  // Called on connect so an open stream counts as activity for idle-shutdown.
  onActivity?: () => void
}

const LEVELS_INTERVAL_MS = 100
const STATUS_INTERVAL_MS = 2000

export function handleEventsRequest(ctx: EventsContext): Response {
  const orch = ctx.orchestrator
  const encoder = new TextEncoder()
  let unsubscribe = () => {}
  let levelsTimer: ReturnType<typeof setInterval> | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream({
    start(controller) {
      ctx.onActivity?.()
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }

      send('status', statusPayload(orch))
      unsubscribe = orch.events.subscribe((event) => {
        if (event.type === 'audio_level') return
        send('capture', event)
      })
      levelsTimer = setInterval(() => send('levels', readLevels()), LEVELS_INTERVAL_MS)
      statusTimer = setInterval(() => send('status', statusPayload(orch)), STATUS_INTERVAL_MS)
    },
    cancel() {
      unsubscribe()
      if (levelsTimer) clearInterval(levelsTimer)
      if (statusTimer) clearInterval(statusTimer)
    },
  })

  return new Response(stream, {
    headers: ctx.headers({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
    }),
  })
}
