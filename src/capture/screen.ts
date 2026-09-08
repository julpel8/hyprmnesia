import { randomUUIDv7 } from 'bun'
import type { ScreenCaptureConfig } from '../config'
import type { EventBus, WindowContext } from '../core/events'
import type { OcrEngine } from '../process/types'
import type { BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import { isWebp } from '../util/webp'
import { needsImageTranscode, transcodeImage } from './ffmpeg'
import type { SckBus, SckFrameEvent } from './sck'
import { createWlcapBus } from './wlcap'

interface FrameBus {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: (frame: SckFrameEvent) => void): () => void
}

type StoredImageExt = 'png' | 'jpg' | 'webp'
type CaptureImageFormat = 'png' | 'jpg'

export interface ScreenCaptureDeps {
  cfg: ScreenCaptureConfig
  blobs: BlobStore
  store: ChunkStore
  ocr: OcrEngine
  events: EventBus
  sck?: SckBus
  getWindow?: () => WindowContext | undefined
}

export interface CaptureRunner {
  stop: () => void
  done: Promise<void>
}

function captureImageFormat(format: ScreenCaptureConfig['format']): CaptureImageFormat {
  return format === 'webp' ? 'png' : format
}

function frameExt(format: SckFrameEvent['format']): CaptureImageFormat {
  return format === 'jpeg' ? 'jpg' : 'png'
}

async function prepareImageForStorage(
  raw: Buffer,
  fallbackExt: CaptureImageFormat,
  opts: { format: ScreenCaptureConfig['format']; quality: number; maxWidth: number },
): Promise<{ image: Buffer; ext: StoredImageExt }> {
  if (!needsImageTranscode(opts)) return { image: raw, ext: fallbackExt }
  const image = await transcodeImage(raw, opts)
  if (opts.format === 'webp') {
    return { image, ext: isWebp(image) ? 'webp' : fallbackExt }
  }
  return { image, ext: opts.format }
}

// Backend selection: Wayland uses the xdg-desktop-portal ScreenCast helper
// (hpm-wlcap), macOS the ScreenCaptureKit one (hpm-sck). There is no fallback —
// the X11 path shelled out to ImageMagick's `import` once per frame and is
// gone.
export function startScreenCapture({
  cfg,
  blobs,
  store,
  ocr,
  events,
  sck,
  getWindow,
}: ScreenCaptureDeps): CaptureRunner {
  if (!cfg.enabled) {
    events.publish({
      type: 'log',
      at: Date.now(),
      level: 'info',
      message: 'screen capture disabled',
    })
    return { stop: () => {}, done: Promise.resolve() }
  }

  // if (process.platform === 'darwin' && sck) {
  //   return startWorkerScreen({ cfg, blobs, store, ocr, events, getWindow }, sck, 'sck')
  // }

  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    const imageFormat = captureImageFormat(cfg.format)
    const wlcap = createWlcapBus(
      {
        frameIntervalMs: cfg.interval_ms,
        imageFormat,
        jpegQuality: cfg.quality,
      },
      events,
    )
    return startWorkerScreen({ cfg, blobs, store, ocr, events, getWindow }, wlcap, 'wlcap')
  }

  events.publish({
    type: 'log',
    at: Date.now(),
    level: 'warn',
    message: `screen capture unavailable on ${process.platform}${
      process.platform === 'linux' ? ' without WAYLAND_DISPLAY' : ''
    }; no capture backend for this session`,
  })
  return { stop: () => {}, done: Promise.resolve() }
}

function startWorkerScreen(
  { cfg, blobs, store, ocr, events, getWindow }: ScreenCaptureDeps,
  frames: FrameBus,
  engine: string,
): CaptureRunner {
  let running = true
  let lastAcceptedAt = 0

  async function processFrame(frame: SckFrameEvent) {
    const start = Date.now()
    const fallbackExt = frameExt(frame.format)
    try {
      const text = await ocr.process(frame.image)
      const { image, ext } = await prepareImageForStorage(frame.image, fallbackExt, {
        format: cfg.format,
        quality: cfg.quality,
        maxWidth: cfg.max_width,
      })
      const id = randomUUIDv7()
      const blob = await blobs.write('screenshot', id, ext, image, frame.at)
      const window = getWindow?.()
      store.insert({
        id,
        kind: 'screenshot',
        at: frame.at,
        blob: blob.rel,
        bytes: image.length,
        text,
        capture_ms: Date.now() - start,
        window,
        ocr: { engine: ocr.name },
      })
      events.publish({
        type: 'chunk',
        source: 'screen',
        at: frame.at,
        id,
        path: blob.abs,
        bytes: image.length,
        text_len: text.length,
        capture_ms: Date.now() - start,
        window,
      })
    } catch (err) {
      events.publish({ type: 'error', source: 'screen', at: Date.now(), message: String(err) })
    }
  }

  const done = (async () => {
    try {
      await frames.start()
    } catch (err) {
      events.publish({
        type: 'error',
        source: 'screen',
        at: Date.now(),
        message: `${engine} start failed: ${String(err)}`,
      })
      return
    }
    if (!running) return

    events.publish({
      type: 'started',
      source: 'screen',
      at: Date.now(),
      meta: { interval_ms: cfg.interval_ms, format: cfg.format, engine },
    })

    let pending: Promise<void> = Promise.resolve()
    const unsubscribe = frames.onFrame((frame) => {
      if (!running) return
      // Frames may arrive faster than interval_ms; throttle to interval_ms.
      if (frame.at - lastAcceptedAt < cfg.interval_ms) return
      lastAcceptedAt = frame.at
      pending = pending.then(() => processFrame(frame))
    })

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!running) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })

    unsubscribe()
    await pending.catch(() => {})
    events.publish({ type: 'stopped', source: 'screen', at: Date.now() })
  })()

  return {
    done,
    stop: () => {
      running = false
    },
  }
}
