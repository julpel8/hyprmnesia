import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { findNativeBinary } from '../../util/native_worker'
import type { OcrEngine } from '../types'

// engine that delegates to the hpm-ocr native helper.
// on Windows: hpm-ocr uses Windows.Media.Ocr (built into Windows 10+).
// on macOS: hpm-ocr uses Apple's Vision text recognition framework.
// other platforms return false so the `auto` engine can fall back to tesseract.

interface OcrResponse {
  ok: boolean
  engine?: string
  text?: string
  lines?: string[]
  language?: string
  error?: string
}

async function runHelper(binary: string, imagePath: string): Promise<OcrResponse> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(binary, [imagePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      const trimmed = out.trim()
      if (!trimmed) {
        reject(new Error(`hpm-ocr exited ${code} with no output${err ? `: ${err.trim()}` : ''}`))
        return
      }
      try {
        const parsed = JSON.parse(trimmed) as OcrResponse
        resolveP(parsed)
      } catch (_e) {
        reject(new Error(`hpm-ocr invalid JSON: ${trimmed.slice(0, 200)}`))
      }
    })
  })
}

export class NativeOcr implements OcrEngine {
  readonly name = 'native'
  private binary?: string
  private readyCache?: boolean

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    const bin = findNativeBinary('hpm-ocr')
    if (!bin) {
      this.readyCache = false
      return false
    }
    this.binary = bin
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      this.readyCache = false
      return false
    }
    this.readyCache = true
    return true
  }

  async process(image: Buffer): Promise<string> {
    if (!this.binary) throw new Error('native ocr binary not located; did you run `bun run build`?')
    const tmp = join(tmpdir(), `hpm-ocr-${randomUUIDv7()}.png`)
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, image)
    try {
      const res = await runHelper(this.binary, tmp)
      if (!res.ok) throw new Error(res.error ?? 'hpm-ocr failed')
      return res.text ?? ''
    } finally {
      await Bun.file(tmp)
        .delete()
        .catch(() => {})
    }
  }
}
