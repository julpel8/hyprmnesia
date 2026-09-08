// Reads the text of stored screenshots, off the capture path.
//
// OCR takes seconds per frame. Running it where frames arrive blocks the drain
// of the capture helper's stdout, which fills the pipe, blocks the helper's
// write, and stalls the frame source — captures collapsed to one every few
// minutes that way. So capture stores the blob and returns, leaving the row with
// no `ocr_engine`, and this loop picks those rows up afterwards.
//
// The rows are the queue: nothing is held in memory, and a restart resumes
// wherever it stopped instead of losing the backlog.

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { needsImageTranscode, transcodeImage } from '../capture/ffmpeg'
import type { EventBus } from '../core/events'
import type { ChunkStore } from '../store/db'
import { isWebp } from '../util/webp'
import type { OcrEngine } from './types'

export interface OcrQueueOptions {
  // This machine's own directory inside the shared tree; stored blob paths are
  // relative to it.
  hostDir: string
  batchSize?: number
}

const IDLE_SLEEP_MS = 2_000
const BUSY_SLEEP_MS = 0
const DEFAULT_BATCH = 8

export class OcrQueue {
  private running = false
  private wake?: () => void
  private loopDone?: Promise<void>

  constructor(
    private engine: OcrEngine,
    private store: ChunkStore,
    private events: EventBus,
    private opts: OcrQueueOptions,
  ) {}

  start(): void {
    if (this.engine.name === 'noop') {
      this.log('info', 'OCR disabled; screenshots are stored without text')
      return
    }
    this.running = true
    this.loopDone = this.loop()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.wake?.()
    await this.loopDone?.catch(() => {})
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let drained = 0
      try {
        drained = await this.drainOnce()
      } catch (err) {
        this.log('warn', `ocr drain failed: ${err}`)
      }
      if (!this.running) break
      await this.sleep(drained > 0 ? BUSY_SLEEP_MS : IDLE_SLEEP_MS)
    }
  }

  private async drainOnce(): Promise<number> {
    const pending = this.store.pendingOcr(this.opts.batchSize ?? DEFAULT_BATCH)
    let done = 0
    for (const row of pending) {
      if (!this.running) break
      const text = await this.readText(row.blob)
      // Written even when empty: `ocr_engine` is what retires the row from the
      // queue, so a blank screen must not be read again on every pass.
      this.store.finalizeOcr(row.id, text ?? '', this.engine.name)
      done++
    }
    return done
  }

  private async readText(blob: string): Promise<string | undefined> {
    const path = isAbsolute(blob) ? blob : join(this.opts.hostDir, blob)
    try {
      const stored = await readFile(path)
      return await this.engine.process(await decodeForOcr(stored))
    } catch (err) {
      this.log('warn', `ocr failed for ${blob}: ${err}`)
      return undefined
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
    })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.events.publish({ type: 'log', at: Date.now(), level, message })
  }
}

// Both OCR engines hand the bytes to a decoder that may not know WebP, which is
// the default storage format. PNG and JPEG go through untouched.
async function decodeForOcr(stored: Buffer): Promise<Buffer> {
  if (!isWebp(stored)) return stored
  const opts = { format: 'png' as const, quality: 100, maxWidth: 0 }
  if (!needsImageTranscode(opts)) {
    // png at native size is a pass-through in `transcodeImage`'s eyes, so ask
    // for the re-encode explicitly through a width that never downscales.
    return await transcodeImage(stored, { ...opts, maxWidth: 1 << 20 })
  }
  return await transcodeImage(stored, opts)
}
