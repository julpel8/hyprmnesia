// OCR on a Hailo NPU (Raspberry Pi 5 + Hailo-8 HAT).
//
// Spawns the bundled `hpm-ocr-hailo.py` worker (see ../../../hailo-ocr/)
// and talks NDJSON over stdio, the same pattern as hpm-asr. The worker loads
// the two PaddleOCR HEF models once at startup; each image is one request.
// Capture never waits on it: OcrQueue drains the pending rows at its own pace.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { LineBuffer } from '../../util/native_worker'
import type { OcrEngine } from '../types'

export interface HailoOptions {
  // Upscale factor before OCR. 1 on large screens, 2 helps small screens.
  scale?: number
  // Drop lines whose mean confidence is below this.
  min_conf?: number
  // Absolute paths to the HEF models. Defaults:
  //   $HPM_OCR_DET  or ~/.hyprmnesia/ocr-models/ocr_det.hef
  //   $HPM_OCR_REC  or ~/.hyprmnesia/ocr-models/ocr.hef
  det_model?: string
  rec_model?: string
  // Interpreter used to spawn the worker. Defaults to $HPM_OCR_PYTHON or python3.
  python?: string
  // Worker script to spawn (argv[1]). Test seam; defaults to the bundled
  // hpm-ocr-hailo.py found by findHailoOcrHelper().
  helper?: string
}

const ENGINE = 'hailo'
const HELPER = 'hpm-ocr-hailo.py'
// Model load on the RPi plus python imports stay well under this.
const READY_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5_000

export function defaultDetModel(): string {
  return process.env.HPM_OCR_DET ?? join(homedir(), '.hyprmnesia', 'ocr-models', 'ocr_det.hef')
}

export function defaultRecModel(): string {
  return process.env.HPM_OCR_REC ?? join(homedir(), '.hyprmnesia', 'ocr-models', 'ocr.hef')
}

export function findHailoOcrHelper(): string | undefined {
  const candidates = [
    join(dirname(process.execPath), 'native', HELPER),
    join(process.cwd(), 'dist', 'native', HELPER),
    resolve('hailo-ocr', HELPER),
  ]
  return candidates.find((p) => existsSync(p))
}

interface HailoWorkerMessage {
  type?: string
  id?: number
  ok?: boolean
  text?: string
  error?: string
}

export class HailoOcr implements OcrEngine {
  readonly name = ENGINE
  private proc?: ChildProcessWithoutNullStreams
  private readonly lines = new LineBuffer()
  private readonly pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (err: Error) => void }
  >()
  private nextId = 1
  private readyCache?: boolean
  private readyPromise?: Promise<void>

  constructor(private opts: HailoOptions = {}) {}

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    const helper = this.opts.helper ?? findHailoOcrHelper()
    const det = this.opts.det_model ?? defaultDetModel()
    const rec = this.opts.rec_model ?? defaultRecModel()
    const python = this.opts.python ?? process.env.HPM_OCR_PYTHON ?? 'python3'
    if (!helper || !existsSync(det) || !existsSync(rec)) {
      // Missing helper, models or NPU setup: the daemon reports it at start.
      this.readyCache = false
      return false
    }
    if (spawnSync(python, ['--version'], { stdio: 'ignore' }).status !== 0) {
      this.readyCache = false
      return false
    }
    this.spawnWorker(python, helper)
    try {
      await this.readyPromise
      this.readyCache = true
      return true
    } catch {
      await this.close()
      this.readyCache = false
      return false
    }
  }

  async process(image: Buffer): Promise<string> {
    const proc = this.proc
    if (!proc) throw new Error('hailo ocr worker is not running')
    const id = this.nextId++
    return new Promise<string>((resolveP, rejectP) => {
      this.pending.set(id, { resolve: resolveP, reject: rejectP })
      const request = {
        type: 'ocr',
        id,
        image: image.toString('base64'),
        scale: this.opts.scale,
        min_conf: this.opts.min_conf,
      }
      try {
        proc.stdin.write(`${JSON.stringify(request)}\n`, (err) => {
          if (!err) return
          const entry = this.pending.get(id)
          this.pending.delete(id)
          entry?.reject(err)
        })
      } catch (err) {
        const entry = this.pending.get(id)
        this.pending.delete(id)
        entry?.reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async close(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    if (!proc) return
    await new Promise<void>((resolveP) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolveP()
      }, CLOSE_TIMEOUT_MS)
      proc.once('close', () => {
        clearTimeout(timer)
        resolveP()
      })
      try {
        proc.stdin.write(`${JSON.stringify({ type: 'quit' })}\n`)
      } catch {
        proc.kill()
      }
    })
  }

  private spawnWorker(python: string, helper: string): void {
    const env = {
      ...process.env,
      HPM_OCR_DET: this.opts.det_model ?? defaultDetModel(),
      HPM_OCR_REC: this.opts.rec_model ?? defaultRecModel(),
    }
    const proc = spawn(python, [helper], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    this.readyPromise = new Promise<void>((resolveP, rejectP) => {
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectP(new Error(message))
      }
      const timer = setTimeout(() => fail('hailo ocr worker timed out loading models'), READY_TIMEOUT_MS)
      proc.stdout.on('data', (chunk: Buffer) => {
        for (const line of this.lines.push(chunk.toString('utf8'))) {
          const text = line.trim()
          if (!text) continue
          let msg: HailoWorkerMessage
          try {
            msg = JSON.parse(text) as HailoWorkerMessage
          } catch {
            continue
          }
          if (msg.type === 'ready' && !settled) {
            settled = true
            clearTimeout(timer)
            resolveP()
            continue
          }
          if (msg.type === 'fatal') {
            fail(msg.error ?? 'hailo ocr worker failed to start')
            continue
          }
          this.handleResult(msg)
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        // Timing lines from the worker; kept out of the way but not lost.
        const text = chunk.toString('utf8').trim()
        if (text) process.stderr.write(`${text}\n`)
      })
      proc.on('error', (err) => fail(err.message))
      proc.on('close', (code) => {
        fail(`hailo ocr worker exited (${code}) before ready`)
        for (const [id, entry] of this.pending) {
          this.pending.delete(id)
          entry.reject(new Error(`hailo ocr worker exited (${code})`))
        }
      })
    })
  }

  private handleResult(msg: HailoWorkerMessage): void {
    if (msg.type !== 'result' || typeof msg.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    if (msg.ok) entry.resolve(typeof msg.text === 'string' ? msg.text : '')
    else entry.reject(new Error(`hailo ocr failed: ${msg.error ?? 'unknown error'}`))
  }
}
