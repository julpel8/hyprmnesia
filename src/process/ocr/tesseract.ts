import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type { OcrEngine } from '../types'

// Fallback engine that shells out to `tesseract`.
// We search PATH plus common package-manager locations because desktop
// autostart sessions often inherit a smaller PATH than terminals.
// install: Debian -> `apt install tesseract-ocr`

interface TesseractSearchOptions {
  binary?: string
  env?: NodeJS.ProcessEnv
}

const COMMON_TESSERACT_DIRS = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/bin']

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

export function tesseractSearchPaths(opts: TesseractSearchOptions = {}): string[] {
  const env = opts.env ?? process.env
  const command = opts.binary ?? env.HPM_TESSERACT ?? env.TESSERACT_BINARY ?? 'tesseract'
  if (posix.isAbsolute(command) || command.includes('/')) return [command]

  const pathDirs = (env.PATH ?? '')
    .split(':')
    .map((dir) => dir.trim())
    .filter(Boolean)
  const dirs = unique([...pathDirs, ...COMMON_TESSERACT_DIRS])
  return unique(dirs.map((dir) => posix.join(dir, command)))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findTesseractBinary(opts: TesseractSearchOptions = {}): string | undefined {
  return tesseractSearchPaths(opts).find(isExecutable)
}

function runTesseract(binary: string, imagePath: string, lang?: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const args = [imagePath, '-']
    if (lang) args.push('-l', lang)
    args.push('--psm', '6')
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
      if (code !== 0) {
        reject(new Error(`tesseract exited ${code}: ${err.trim()}`))
        return
      }
      resolveP(out)
    })
  })
}

export interface TesseractOptions {
  lang?: string
  binary?: string
}

export class TesseractOcr implements OcrEngine {
  readonly name = 'tesseract'
  private binary?: string
  private readyCache?: boolean
  constructor(private opts: TesseractOptions = {}) {}

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = findTesseractBinary({ binary: this.opts.binary })
    this.readyCache = this.binary !== undefined
    return this.readyCache
  }

  async process(image: Buffer): Promise<string> {
    if (!this.binary) throw new Error('tesseract not found in PATH or common install locations')
    const tmp = join(tmpdir(), `hpm-ocr-${randomUUIDv7()}.png`)
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, image)
    try {
      const text = await runTesseract(this.binary, tmp, this.opts.lang)
      return text.trim()
    } finally {
      await Bun.file(tmp)
        .delete()
        .catch(() => {})
    }
  }
}
