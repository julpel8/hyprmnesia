// Daemon dashboard routes. Status is a superset of `hpm status --json` plus the
// remote orchestrator's per-source view. Start/stop/restart go through the
// orchestrator, which spawns `hpm _daemon` / `hpm stop` as detached children —
// never the tray, and never the in-process stopDaemon() (it blocks on
// Atomics.wait). See CLAUDE.md.

import { existsSync, readFileSync } from 'node:fs'
import { daemonPid, ERR_LOG_FILE, isDaemonAlive, LOG_FILE, readLevels } from '../../core/daemon'
import type { Orchestrator } from '../../core/orchestrator'

export interface DaemonContext {
  orchestrator: Orchestrator
  headers: (extra?: Record<string, string>) => Record<string, string>
}

export function statusPayload(orch: Orchestrator) {
  const pid = daemonPid()
  const running = pid !== undefined && isDaemonAlive()
  return {
    ...orch.status(),
    pid: running ? pid : null,
    logs: LOG_FILE,
    errors: process.platform === 'win32' ? ERR_LOG_FILE : LOG_FILE,
    levels: readLevels(),
  }
}

function tailLog(n: number): string[] {
  if (!existsSync(LOG_FILE)) return []
  const text = readFileSync(LOG_FILE, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.slice(-n)
}

// Waits until the daemon is no longer alive (bounded). stop() already awaits
// `hpm stop`, so this is a cheap belt-and-braces against a stale pid file.
async function waitForStopped(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isDaemonAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// Full stop-then-start cycle, shared with the settings apply-and-restart route.
export async function restartDaemon(orch: Orchestrator): Promise<void> {
  await orch.stop()
  await waitForStopped()
  await orch.start()
}

export async function handleDaemonRequest(
  req: Request,
  url: URL,
  ctx: DaemonContext,
): Promise<Response | undefined> {
  if (url.pathname === '/api/status') {
    return Response.json(statusPayload(ctx.orchestrator), { headers: ctx.headers() })
  }

  if (url.pathname === '/api/logs') {
    const requested = Number(url.searchParams.get('n'))
    const n = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 2000)
    return Response.json({ lines: tailLog(n) }, { headers: ctx.headers() })
  }

  if (url.pathname === '/api/daemon/start') {
    if (req.method !== 'POST')
      return new Response('method not allowed', { status: 405, headers: ctx.headers() })
    await ctx.orchestrator.start()
    return Response.json({ ok: true }, { headers: ctx.headers() })
  }

  if (url.pathname === '/api/daemon/stop') {
    if (req.method !== 'POST')
      return new Response('method not allowed', { status: 405, headers: ctx.headers() })
    await ctx.orchestrator.stop()
    return Response.json({ ok: true }, { headers: ctx.headers() })
  }

  if (url.pathname === '/api/daemon/restart') {
    if (req.method !== 'POST')
      return new Response('method not allowed', { status: 405, headers: ctx.headers() })
    await restartDaemon(ctx.orchestrator)
    return Response.json({ ok: true }, { headers: ctx.headers() })
  }

  return undefined
}
