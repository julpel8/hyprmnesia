import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Resolve a bundled native helper (hpm-asr, hpm-embed, hpm-wlcap, ...) by base
// name. Searches next to the running executable first, then the dist/ and
// target/release build outputs. Returns the first existing path, or undefined
// when the helper has not been built.
export function findNativeBinary(baseName: string): string | undefined {
  const candidates = [
    join(dirname(process.execPath), 'native', baseName),
    join(dirname(process.execPath), baseName),
    join(process.cwd(), 'dist', 'native', baseName),
    join(process.cwd(), 'dist', baseName),
    join(process.cwd(), 'target', 'release', baseName),
  ]
  return candidates.find((p) => existsSync(p))
}

// Splits a byte stream into newline-delimited records. Feed raw stdout chunks
// to push(); it returns the complete lines and retains any trailing partial
// line for the next call. Blank lines are returned as-is so callers keep their
// own filtering.
export class LineBuffer {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines
  }
}

export interface NativeWorkerHandlers {
  // Called once per complete stdout line (NDJSON record, possibly blank).
  onLine: (line: string) => void
  // Called with trimmed, non-empty stderr text.
  onStderr?: (text: string) => void
  // Spawn failure (e.g. binary missing/not executable).
  onError: (err: Error) => void
  // Process exit. Fires before stop()'s promise resolves.
  onClose: (code: number | null) => void
}

// Shared lifecycle for the NDJSON-over-stdio native helpers: spawns the child
// with piped stdio, line-buffers stdout, forwards stderr/error/close, and
// writes JSON requests. Each helper layers its own typed message handling on
// top via onLine.
export class NativeWorker {
  private proc?: ChildProcessWithoutNullStreams
  private readonly lines = new LineBuffer()

  constructor(
    private readonly binary: string,
    private readonly handlers: NativeWorkerHandlers,
  ) {}

  get running(): boolean {
    return this.proc !== undefined
  }

  spawn(args: string[] = []): void {
    const proc = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.lines.push(chunk.toString('utf8'))) this.handlers.onLine(line)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.handlers.onStderr?.(text)
    })
    proc.on('error', (err) => {
      this.handlers.onError(err instanceof Error ? err : new Error(String(err)))
    })
    proc.on('close', (code) => {
      this.proc = undefined
      this.handlers.onClose(code)
    })
  }

  // Write a JSON request as a single NDJSON line. No-op once the process exits.
  send(value: Record<string, unknown>): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(`${JSON.stringify(value)}\n`)
    } catch {
      // process already gone
    }
  }

  // Ask the worker to shut down, then wait for exit; force-kill after timeoutMs.
  async stop(shutdown: Record<string, unknown>, timeoutMs: number): Promise<void> {
    const proc = this.proc
    if (!proc) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolve()
      }, timeoutMs)
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      this.send(shutdown)
    })
  }
}
