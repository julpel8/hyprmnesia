// OCR with RapidOCR (PaddleOCR models) on the CPU.
//
// Spawns the bundled `hpm-ocr-rapid.py` worker (see ../../../rapidocr-ocr/)
// and talks NDJSON over stdio, the same pattern as hpm-asr and the Hailo
// engine. The worker builds the RapidOCR engine once at startup (models ship
// inside the rapidocr_* wheel); each image is one request.
//
// For a dense 1920-wide screen capture the worker takes ~3 s per frame on an
// 8-core laptop CPU (OpenVINO backend), versus ~14 s for tesseract at 2560
// wide. Capture never waits on it: OcrQueue drains the pending rows at its
// own pace.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LineBuffer } from '../../util/native_worker'
import type { OcrEngine } from '../types'

export interface RapidOcrOptions {
  // Upscale/downscale factor applied to the image before OCR. 1 is the
  // default; RapidOCR already resizes the detection input
  // (det_limit_side_len), so scaling the whole image is a coarser lever.
  scale?: number
  // Drop lines whose confidence is below this.
  min_conf?: number
  // Longest side (px) the detection network is fed. 1280 is the default, a
  // good speed/detail trade-off measured on screen captures.
  det_limit_side_len?: number
  // Backend: 'auto' (default, OpenVINO if importable else onnxruntime),
  // 'openvino', or 'onnxruntime'.
  backend?: string
  // Interpreter used to spawn the worker. Defaults to $HPM_OCR_PYTHON or
  // python3. The interpreter must have rapidocr_openvino or
  // rapidocr_onnxruntime installed (a dedicated venv is the clean setup).
  python?: string
  // Worker script to spawn (argv[1]). Test seam; defaults to the bundled
  // hpm-ocr-rapid.py found by findRapidOcrHelper().
  helper?: string
}

const ENGINE = 'rapidocr'
const HELPER = 'hpm-ocr-rapid.py'
// Cold start: python imports + OpenVINO model compilation on the first
// backend load. Measured under 5 s warm; allow headroom for a cold CPU.
const READY_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 5_000

export function findRapidOcrHelper(): string | undefined {
  const candidates = [
    join(dirname(process.execPath), 'native', HELPER),
    join(process.cwd(), 'dist', 'native', HELPER),
    resolve('rapidocr-ocr', HELPER),
  ]
  return candidates.find((p) => existsSync(p))
}

interface RapidWorkerMessage {
  type?: string
  id?: number
  ok?: boolean
  text?: string
  error?: string
  backend?: string
}

export class RapidOcr implements OcrEngine {
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

  constructor(private opts: RapidOcrOptions = {}) {}

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    const helper = this.opts.helper ?? findRapidOcrHelper()
    const python = this.opts.python ?? process.env.HPM_OCR_PYTHON ?? 'python3'
    if (!helper) {
      // Missing worker: the daemon reports it at start.
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
    if (!proc) throw new Error('rapidocr worker is not running')
    const id = this.nextId++
    return new Promise<string>((resolveP, rejectP) => {
      this.pending.set(id, { resolve: resolveP, reject: rejectP })
      const request = {
        type: 'ocr',
        id,
        image: image.toString('base64'),
        scale: this.opts.scale,
        min_conf: this.opts.min_conf,
        det_limit_side_len: this.opts.det_limit_side_len,
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
      HPM_OCR_RAPID_BACKEND: this.opts.backend ?? 'auto',
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
      const timer = setTimeout(
        () => fail('rapidocr worker timed out loading models'),
        READY_TIMEOUT_MS,
      )
      proc.stdout.on('data', (chunk: Buffer) => {
        for (const line of this.lines.push(chunk.toString('utf8'))) {
          const text = line.trim()
          if (!text) continue
          let msg: RapidWorkerMessage
          try {
            msg = JSON.parse(text) as RapidWorkerMessage
          } catch {
            continue
          }
          if (msg.type === 'ready' && !settled) {
            settled = true
            clearTimeout(timer)
            if (msg.backend) {
              process.stderr.write(`hpm: rapidocr backend: ${msg.backend}\n`)
            }
            resolveP()
            continue
          }
          if (msg.type === 'fatal') {
            fail(msg.error ?? 'rapidocr worker failed to start')
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
        fail(`rapidocr worker exited (${code}) before ready`)
        for (const [id, entry] of this.pending) {
          this.pending.delete(id)
          entry.reject(new Error(`rapidocr worker exited (${code})`))
        }
      })
    })
  }

  private handleResult(msg: RapidWorkerMessage): void {
    if (msg.type !== 'result' || typeof msg.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    if (msg.ok) entry.resolve(typeof msg.text === 'string' ? msg.text : '')
    else entry.reject(new Error(`rapidocr ocr failed: ${msg.error ?? 'unknown error'}`))
  }
}
