// Audio capture switches for the dashboard. POST /api/capture/mic|system flips
// (or sets) the persisted enabled flag and restarts the daemon when it is
// running, since capture config is only read at daemon startup.

import { type AudioCaptureState, isAudioSource, setAudioCapture } from '../../core/capture_toggle'
import { isDaemonAlive } from '../../core/daemon'
import type { Orchestrator } from '../../core/orchestrator'
import { restartDaemon } from './daemon'

export interface CaptureContext {
  orchestrator: Orchestrator
  headers: (extra?: Record<string, string>) => Record<string, string>
}

export async function handleCaptureRequest(
  req: Request,
  url: URL,
  ctx: CaptureContext,
): Promise<Response | undefined> {
  const match = /^\/api\/capture\/([a-z]+)$/.exec(url.pathname)
  if (!match) return undefined
  const source = match[1] as string
  if (!isAudioSource(source)) {
    return new Response('unknown capture source', { status: 404, headers: ctx.headers() })
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: ctx.headers() })
  }

  let enabled: boolean | undefined
  try {
    const raw = await req.text()
    if (raw.trim()) {
      const body = JSON.parse(raw)
      if (typeof body?.enabled === 'boolean') enabled = body.enabled
    }
  } catch {
    return new Response('invalid JSON', { status: 400, headers: ctx.headers() })
  }

  let state: AudioCaptureState
  try {
    state = setAudioCapture(source, enabled)
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), {
      status: 400,
      headers: ctx.headers(),
    })
  }

  const restarted = isDaemonAlive()
  if (restarted) await restartDaemon(ctx.orchestrator)
  return Response.json({ capture: state, restarted }, { headers: ctx.headers() })
}
