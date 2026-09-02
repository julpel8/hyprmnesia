import type { EventBus } from '../../core/events'
import { findNativeBinary, NativeWorker } from '../../util/native_worker'
import type {
  EmbeddingCallbacks,
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingStatus,
} from '../types'

export interface LocalEmbeddingOptions {
  model?: string
  dim?: number
}

const DEFAULT_MODEL = 'multilingual-e5-small'
const DEFAULT_DIM = 384
const EMBED_TIMEOUT_MS = 60_000

type WorkerMessage =
  | { type: 'ready'; engine: string; model?: string; dim?: number }
  | { type: 'status'; status: EmbeddingStatus['status']; engine?: string; message?: string }
  | { type: 'embedding'; id: string; kind?: string; vector: number[] }
  | { type: 'error'; id?: string; engine?: string; message: string }

function emitLog(
  events: EventBus | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: unknown,
) {
  events?.publish({ type: 'log', at: Date.now(), level, message, extra })
}

interface Pending {
  resolve: (result: EmbeddingResult) => void
  reject: (err: Error) => void
  kind: EmbeddingRequest['kind']
  timer: ReturnType<typeof setTimeout>
}

export class LocalEmbedding implements EmbeddingEngine {
  readonly name: string
  readonly dim: number
  private binary?: string
  private worker?: NativeWorker
  private callbacks?: EmbeddingCallbacks
  private readyCache?: boolean
  private model: string
  private pending = new Map<string, Pending>()

  constructor(
    opts: LocalEmbeddingOptions = {},
    private events?: EventBus,
  ) {
    this.model = typeof opts.model === 'string' && opts.model ? opts.model : DEFAULT_MODEL
    this.dim = typeof opts.dim === 'number' && opts.dim > 0 ? Math.trunc(opts.dim) : DEFAULT_DIM
    this.name = `local:${this.model}`
  }

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = findNativeBinary('hpm-embed')
    this.readyCache = Boolean(this.binary)
    if (!this.readyCache) {
      emitLog(
        this.events,
        'warn',
        'hpm-embed binary not found; semantic search disabled. Run `bun run build` or `cargo build --release --workspace`',
      )
    }
    return this.readyCache
  }

  async start(callbacks: EmbeddingCallbacks): Promise<void> {
    this.callbacks = callbacks
    if (this.worker?.running) return
    const ok = await this.ready()
    if (!ok || !this.binary) throw new Error('hpm-embed binary not located')

    callbacks.onStatus({ status: 'starting', engine: this.name, message: 'starting embed worker' })
    this.worker = new NativeWorker(this.binary, {
      onLine: (line) => this.handleLine(line),
      onStderr: (text) => emitLog(this.events, 'warn', `hpm-embed stderr: ${text}`),
      onError: (err) => {
        callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
        this.rejectAll(err)
      },
      onClose: (code) => {
        callbacks.onStatus({
          status: 'stopped',
          engine: this.name,
          message: `hpm-embed exited ${code}`,
        })
        this.rejectAll(new Error(`hpm-embed exited ${code}`))
      },
    })
    this.worker.spawn()

    this.send({ type: 'init', model: this.model, dim: this.dim })
  }

  async embed(requests: EmbeddingRequest[]): Promise<EmbeddingResult[]> {
    if (requests.length === 0) return []
    if (!this.worker?.running) throw new Error('hpm-embed worker not started')
    const promises = requests.map(
      (req) =>
        new Promise<EmbeddingResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(req.id)
            reject(new Error(`hpm-embed timed out for ${req.id}`))
          }, EMBED_TIMEOUT_MS)
          this.pending.set(req.id, { resolve, reject, kind: req.kind, timer })
          this.send({ type: 'embed', id: req.id, kind: req.kind, text: req.text })
        }),
    )
    return Promise.all(promises)
  }

  async stop(): Promise<void> {
    if (!this.worker?.running) return
    await this.worker.stop({ type: 'shutdown' }, 10_000)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: WorkerMessage
    try {
      msg = JSON.parse(line) as WorkerMessage
    } catch {
      emitLog(this.events, 'warn', `invalid hpm-embed JSON: ${line.slice(0, 200)}`)
      return
    }
    this.handleMessage(msg)
  }

  private handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      this.callbacks?.onStatus({ status: 'ready', engine: msg.engine, message: 'embed ready' })
    } else if (msg.type === 'status') {
      this.callbacks?.onStatus({
        status: msg.status,
        engine: msg.engine ?? this.name,
        message: msg.message,
      })
    } else if (msg.type === 'embedding') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      pending.resolve({ id: msg.id, kind: pending.kind, vector: Float32Array.from(msg.vector) })
    } else if (msg.type === 'error') {
      const message = msg.message || 'hpm-embed error'
      emitLog(this.events, 'error', message, msg)
      if (msg.id) {
        const pending = this.pending.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(msg.id)
          pending.reject(new Error(message))
        }
      } else {
        this.callbacks?.onStatus({ status: 'error', engine: msg.engine ?? this.name, message })
      }
    }
  }

  private send(value: Record<string, unknown>): void {
    this.worker?.send(value)
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pending.delete(id)
    }
  }
}
