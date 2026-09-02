import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type { OcrEngine } from '../types'

// Fallback engine for macOS/Linux that shells out to `tesseract`.
// We search PATH plus common package-manager locations because launchd and
// desktop autostart sessions often inherit a smaller PATH than terminals.
// install: macOS -> `brew install tesseract`
//          Debian -> `apt install tesseract-ocr`

type Platform = NodeJS.Platform

interface TesseractSearchOptions {
  binary?: string
  env?: NodeJS.ProcessEnv
  platform?: Platform
}

function pathApi(platform: Platform) {
  return platform === 'win32' ? win32 : posix
}

function pathDelimiter(platform: Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function commandNames(command: string, env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (platform !== 'win32' || /\.[a-z0-9]+$/i.test(command)) return [command]
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
  return [command, ...exts.map((ext) => `${command}${ext.toLowerCase()}`)]
}

function commonTesseractDirs(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  if (platform === 'linux') return ['/usr/bin', '/usr/local/bin', '/snap/bin', '/bin']
  if (platform === 'win32') {
    return [
      env.ProgramFiles ? win32.join(env.ProgramFiles, 'Tesseract-OCR') : '',
      env['ProgramFiles(x86)'] ? win32.join(env['ProgramFiles(x86)'], 'Tesseract-OCR') : '',
    ]
  }
  return []
}

export function tesseractSearchPaths(opts: TesseractSearchOptions = {}): string[] {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const command = opts.binary ?? env.HPM_TESSERACT ?? env.TESSERACT_BINARY ?? 'tesseract'
  const paths = pathApi(platform)
  if (paths.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [command]
  }

  const names = commandNames(command, env, platform)
  const pathDirs = (env.PATH ?? '')
    .split(pathDelimiter(platform))
    .map((dir) => dir.trim())
    .filter(Boolean)
  const dirs = unique([...pathDirs, ...commonTesseractDirs(env, platform)])
  return unique(dirs.flatMap((dir) => names.map((name) => paths.join(dir, name))))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return process.platform === 'win32' && existsSync(path)
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
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
