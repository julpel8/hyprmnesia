// Ephemeral localhost UI server. Binds a random 127.0.0.1 port and serves the
// (Phase 1: replay) frontend plus its JSON/media API, with no token: anything
// running on this machine can read it. Writes are still refused when they carry
// a foreign Origin (see ./auth). Read routes open the index DB per request, so
// the server works with the daemon stopped. It shuts itself down once the
// browser that pinged it goes quiet.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { makeRemoteOrchestrator } from '../core/remote_orchestrator'
import {
  clearReplayTranscriptionSuppression,
  setReplayTranscriptionSuppression,
} from '../core/transcription_suppression'
import type { ReplayBlobRef } from '../replay/store'
import { handleCaptureRequest } from './api/capture'
import { handleConfigRequest } from './api/config'
import { handleDaemonRequest } from './api/daemon'
import { handleEventsRequest } from './api/events'
import { handleReadRequest } from './api/read'
import { UI_ASSETS, UI_INDEX_HTML } from './assets'
import { isSameOriginRequest, noStoreHeaders } from './auth'

export interface UiServerOptions {
  dbPath?: string
  // Optional deep-link range for the replay view (epoch ms or ISO strings).
  from?: string
  to?: string
  openBrowser?: boolean
  // 'replay' deep-links the replay view; 'ui' opens the dashboard default. In
  // Phase 1 both serve the same placeholder client — only the opened URL differs.
  view?: 'replay' | 'ui'
}

function openUrl(url: string): void {
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  child.unref()
}

export async function startUiServer(options: UiServerOptions): Promise<void> {
  // Identifies this server as the owner of a replay transcription suppression
  // lease, so a second UI server cannot clear ours. Not a credential.
  const ownerId = randomBytes(16).toString('hex')
  const dbPath = options.dbPath
  const view = options.view ?? 'replay'
  const blobs = { current: new Map<string, ReplayBlobRef>() }
  // One orchestrator per server: tails the daemon log + polls levels, shared by
  // the status endpoint and every SSE connection. Disposed on shutdown.
  const orchestrator = makeRemoteOrchestrator()
  let lastPing = Date.now()
  let hadPing = false
  const markActivity = () => {
    lastPing = Date.now()
  }

  let selfOrigin = ''
  const uiHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
    noStoreHeaders(extra)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!isSameOriginRequest(req, selfOrigin))
        return new Response('cross-origin write refused', {
          status: 403,
          headers: noStoreHeaders(),
        })

      if (url.pathname === '/') {
        return new Response(UI_INDEX_HTML, {
          headers: uiHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
        })
      }

      const asset = UI_ASSETS[url.pathname]
      if (asset) {
        return new Response(asset.body, {
          headers: uiHeaders({ 'Content-Type': asset.contentType }),
        })
      }

      if (url.pathname === '/api/ping') {
        hadPing = true
        lastPing = Date.now()
        return Response.json({ ok: true }, { headers: uiHeaders() })
      }

      if (url.pathname === '/api/replay-transcription') {
        if (req.method !== 'POST') {
          return new Response('method not allowed', { status: 405, headers: uiHeaders() })
        }
        let active = false
        let ttlMs: number | undefined
        try {
          const raw = await req.text()
          if (raw.trim()) {
            const body = JSON.parse(raw)
            active = body?.active === true
            ttlMs = typeof body?.ttl_ms === 'number' ? body.ttl_ms : undefined
          }
        } catch {
          return new Response('bad request', { status: 400, headers: uiHeaders() })
        }
        if (active) {
          const until = setReplayTranscriptionSuppression({ owner: ownerId, ttlMs })
          return Response.json({ active: true, until }, { headers: uiHeaders() })
        }
        clearReplayTranscriptionSuppression({ owner: ownerId })
        return Response.json({ active: false }, { headers: uiHeaders() })
      }

      if (url.pathname === '/api/events') {
        return handleEventsRequest({ orchestrator, headers: uiHeaders, onActivity: markActivity })
      }

      const daemon = await handleDaemonRequest(req, url, { orchestrator, headers: uiHeaders })
      if (daemon) return daemon

      const config = await handleConfigRequest(req, url, { orchestrator, headers: uiHeaders })
      if (config) return config

      const capture = await handleCaptureRequest(req, url, { orchestrator, headers: uiHeaders })
      if (capture) return capture

      const read = handleReadRequest(req, url, {
        dbPath,
        blobs,
        headers: uiHeaders,
      })
      if (read) return read

      return new Response('not found', { status: 404, headers: uiHeaders() })
    },
  })

  const port = server.port
  if (port === undefined) throw new Error('ui server failed to bind a port')
  selfOrigin = `http://127.0.0.1:${port}`

  const initialParams = new URLSearchParams()
  if (options.from !== undefined && options.to !== undefined) {
    initialParams.set('from', String(options.from))
    initialParams.set('to', String(options.to))
  }
  const url = `http://127.0.0.1:${port}/?${initialParams.toString()}`
  console.log(`${view}: ${url}`)
  if (options.from !== undefined && options.to !== undefined) {
    console.log(`range: ${options.from} -> ${options.to}`)
  }

  if (options.openBrowser !== false) {
    try {
      openUrl(url)
    } catch (err) {
      console.error(`failed to open browser: ${String(err)}`)
    }
  }

  await new Promise<void>((resolve) => {
    let done = false
    const close = () => {
      if (done) return
      done = true
      clearInterval(staleTimer)
      clearReplayTranscriptionSuppression({ owner: ownerId })
      orchestrator.dispose?.()
      server.stop(true)
      resolve()
    }
    const staleTimer = setInterval(() => {
      const idleMs = Date.now() - lastPing
      // Once a real browser has pinged, 15s of silence means it's gone.
      // Otherwise only auto-give-up when we actually tried to open one — `--no-open`
      // is for scripted/headless use where Ctrl-C is the stop signal.
      if (hadPing && idleMs > 15_000) return close()
      if (options.openBrowser !== false && !hadPing && idleMs > 60_000) close()
    }, 2000)
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  })
}
