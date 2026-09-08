import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EventBus } from '../core/events'
import { findNativeBinary, NativeWorker } from '../util/native_worker'
import { defaultWaylandTokenPath } from '../util/paths'

export interface WlcapBusOptions {
  frameIntervalMs: number
  imageFormat: 'png' | 'jpg'
  jpegQuality?: number
}

export interface WlcapFrameEvent {
  at: number
  width: number
  height: number
  format: 'png' | 'jpeg'
  mime: string
  image: Buffer
}

type WlcapFrameHandler = (event: WlcapFrameEvent) => void

export interface WlcapBus {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: WlcapFrameHandler): () => void
}

type WorkerMessage =
  | { type: 'ready'; engine?: string }
  | { type: 'started'; at: number; frame_interval_ms?: number; restore_token?: string | null }
  | { type: 'stopped'; at: number }
  | {
      type: 'frame'
      at: number
      width: number
      height: number
      format: 'png' | 'jpeg'
      mime: string
      image_b64: string
    }
  | { type: 'error'; at: number; message: string }
  | { type: 'log'; at: number; level: 'info' | 'warn' | 'error'; message: string }

function readRestoreToken(): string | undefined {
  const path = defaultWaylandTokenPath()
  if (!existsSync(path)) return undefined
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

function writeRestoreToken(token: string): void {
  const path = defaultWaylandTokenPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token)
  } catch {
    // best-effort; a missing token just means re-prompting next session
  }
}

export function createWlcapBus(opts: WlcapBusOptions, events: EventBus): WlcapBus {
  let worker: NativeWorker | undefined
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let resolvedStarted: (() => void) | undefined
  let rejectedStarted: ((err: Error) => void) | undefined
  const frameHandlers = new Set<WlcapFrameHandler>()

  function emitLog(level: 'info' | 'warn' | 'error', message: string) {
    events.publish({ type: 'log', at: Date.now(), level, message })
  }

  function publishError(message: string) {
    events.publish({
      type: 'error',
      source: 'screen',
      at: Date.now(),
      message: `wlcap: ${message}`,
    })
  }

  function send(value: Record<string, unknown>) {
    worker?.send(value)
  }

  function handleLine(line: string) {
    if (!line.trim()) return
    let msg: WorkerMessage
    try {
      msg = JSON.parse(line) as WorkerMessage
    } catch {
      emitLog('warn', `invalid hpm-wlcap JSON: ${line.slice(0, 200)}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        send({
          type: 'start',
          frame_interval_ms: opts.frameIntervalMs,
          image_format: opts.imageFormat === 'jpg' ? 'jpeg' : 'png',
          jpeg_quality: opts.jpegQuality,
          restore_token: readRestoreToken(),
        })
        return
      case 'started':
        if (msg.restore_token) writeRestoreToken(msg.restore_token)
        resolvedStarted?.()
        resolvedStarted = undefined
        rejectedStarted = undefined
        return
      case 'stopped':
        return
      case 'frame':
        for (const h of frameHandlers) {
          h({
            at: msg.at,
            width: msg.width,
            height: msg.height,
            format: msg.format,
            mime: msg.mime,
            image: Buffer.from(msg.image_b64, 'base64'),
          })
        }
        return
      case 'error': {
        const err = new Error(msg.message)
        rejectedStarted?.(err)
        rejectedStarted = undefined
        resolvedStarted = undefined
        publishError(msg.message)
        return
      }
      case 'log':
        emitLog(msg.level, `hpm-wlcap: ${msg.message}`)
        return
    }
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise
    const binary = findNativeBinary('hpm-wlcap')
    if (!binary) {
      throw new Error(
        'hpm-wlcap binary not found; run `bun run build` or `cargo build --release --workspace`',
      )
    }
    startPromise = new Promise<void>((resolve, reject) => {
      resolvedStarted = resolve
      rejectedStarted = reject
      worker = new NativeWorker(binary, {
        onLine: handleLine,
        onStderr: (text) => emitLog('warn', `hpm-wlcap stderr: ${text}`),
        onError: (err) => {
          rejectedStarted?.(err)
          rejectedStarted = undefined
          resolvedStarted = undefined
          publishError(`spawn error: ${String(err)}`)
        },
        onClose: (code) => {
          const err = new Error(`hpm-wlcap exited ${code}`)
          rejectedStarted?.(err)
          rejectedStarted = undefined
          resolvedStarted = undefined
          startPromise = undefined
          if (code !== 0 && code !== null) publishError(`exited ${code}`)
        },
      })
      worker.spawn()
    })
    return startPromise
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    if (!worker?.running) return
    stopPromise = worker.stop({ type: 'shutdown' }, 5_000)
    return stopPromise
  }

  function onFrame(handler: WlcapFrameHandler): () => void {
    frameHandlers.add(handler)
    return () => {
      frameHandlers.delete(handler)
    }
  }

  return { start, stop, onFrame }
}
