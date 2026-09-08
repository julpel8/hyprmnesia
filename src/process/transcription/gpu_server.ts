import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Runs one ggml/Vulkan transcription server as a child process and posts audio
// to it. Both engines ship a small HTTP server that loads the model once and
// keeps it on the GPU, which is the whole point: a per-segment CLI call would
// reload a 600 MB model every few seconds.
//
// The two servers speak different dialects, so `flavour` picks the endpoint and
// the field names. Everything else — spawning, waiting for the port, retrying,
// shutting down — is shared.

export type GpuServerFlavour = 'whisper' | 'parakeet'

export interface GpuServerOptions {
  flavour: GpuServerFlavour
  binary: string
  model: string
  port: number
  // Directory holding the .so files the binary was linked against. Both
  // releases ship their ggml backends next to the executable rather than
  // installing them, so the loader needs pointing at it.
  libraryPath?: string
  threads?: number
  // Whisper takes a language hint; 'auto' lets it detect. Parakeet ignores it.
  language?: string
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

const READY_TIMEOUT_MS = 600_000
const REQUEST_TIMEOUT_MS = 120_000

export class GpuAsrServer {
  private proc?: ChildProcess
  private ready?: Promise<void>
  readonly name: string

  constructor(private readonly opts: GpuServerOptions) {
    this.name = `${opts.flavour}:${basenameWithoutExt(opts.model)}`
  }

  get running(): boolean {
    return this.proc !== undefined
  }

  static locate(baseName: string): string | undefined {
    const candidates = [
      join(dirname(process.execPath), 'native', 'gpu', baseName),
      join(process.cwd(), 'dist', 'native', 'gpu', baseName),
    ]
    return candidates.find((path) => existsSync(path))
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.spawnAndWait()
    return this.ready
  }

  private async spawnAndWait(): Promise<void> {
    const { flavour, binary, model, port, libraryPath, threads } = this.opts
    const args =
      flavour === 'whisper'
        ? [
            '--model',
            model,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--threads',
            String(threads ?? 4),
            '--language',
            this.opts.language && this.opts.language !== 'auto' ? this.opts.language : 'auto',
            '--no-timestamps',
          ]
        : [
            '--model',
            model,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--threads',
            String(threads ?? 4),
          ]

    const env = { ...process.env }
    if (libraryPath) {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${libraryPath}:${env.LD_LIBRARY_PATH}`
        : libraryPath
    }

    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    this.proc = proc
    // ggml logs the Vulkan device it picked on stderr; that line is how you can
    // tell the GPU was actually found, so it is worth surfacing.
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      const level = /error|failed/i.test(text) ? 'warn' : 'info'
      this.opts.onLog?.(level, `${this.name}: ${text}`)
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.opts.onLog?.('info', `${this.name}: ${text}`)
    })
    proc.on('close', (code) => {
      this.proc = undefined
      this.ready = undefined
      this.opts.onLog?.('warn', `${this.name} exited (${code})`)
    })

    await this.waitForPort(port)
  }

  // Model load dominates startup and grows with the model, so the wait is long
  // and the failure is explicit rather than a silent first transcription error.
  private async waitForPort(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(`${this.name} exited before it started serving`)
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    throw new Error(`${this.name} did not start listening on ${port}`)
  }

  async transcribe(wav: Buffer): Promise<string> {
    const { flavour, port } = this.opts
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    if (flavour === 'whisper') {
      form.append('response_format', 'json')
      form.append('temperature', '0')
      if (this.opts.language) form.append('language', this.opts.language)
    } else {
      form.append('model', 'parakeet')
      form.append('response_format', 'json')
    }

    const path = flavour === 'whisper' ? '/inference' : '/v1/audio/transcriptions'
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${this.name} returned ${res.status}: ${await res.text()}`)
    const payload = (await res.json()) as { text?: string; transcription?: string }
    return (payload.text ?? payload.transcription ?? '').trim()
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.ready = undefined
    if (!proc) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, 5_000)
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }
}

function basenameWithoutExt(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/^ggml-/, '').replace(/\.(bin|gguf)$/, '')
}
