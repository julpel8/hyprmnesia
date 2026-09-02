import { randomUUIDv7 } from 'bun'
import type { AudioSource, EventBus } from '../../core/events'
import { findNativeBinary, NativeWorker } from '../../util/native_worker'
import type {
  PcmAudioFrame,
  TranscriptionCallbacks,
  TranscriptionEngine,
  TranscriptionSegment,
  TranscriptionStatus,
} from '../types'

export interface AsrOptions {
  model?: string
  language?: string
  // CTranslate2 quantization for the Whisper (faster-whisper) backend.
  compute_type?: string
  live?: {
    enabled?: boolean
    min_segment_ms?: number
    target_segment_ms?: number
    max_segment_ms?: number
    silence_ms?: number
    rms_gate?: number
  }
}

export type AsrEngineFamily = 'whisper' | 'parakeet'

const DEFAULT_WHISPER_MODEL = 'whisper-large-v3-turbo'
const DEFAULT_PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3'

// Model names accepted by hpm-asr. The name prefix selects the backend family
// (whisper-* -> CTranslate2/faster-whisper, parakeet-* -> audiopipe), so the
// sets must stay prefix-consistent and in sync with whisper_repo in
// asr/src/main.rs and WHISPER_MODELS in src/config.ts.
const WHISPER_MODELS = new Set([
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'whisper-medium',
  'whisper-small',
  'whisper-base',
  'whisper-tiny',
])
const PARAKEET_MODELS = new Set([DEFAULT_PARAKEET_MODEL])

export function normalizeAsrModel(family: AsrEngineFamily, model: unknown): string {
  if (family === 'whisper') {
    return typeof model === 'string' && WHISPER_MODELS.has(model) ? model : DEFAULT_WHISPER_MODEL
  }
  return typeof model === 'string' && PARAKEET_MODELS.has(model) ? model : DEFAULT_PARAKEET_MODEL
}

type WorkerMessage =
  | { type: 'ready'; engine: string; model?: string }
  | {
      type: 'status'
      status: TranscriptionStatus['status']
      engine?: string
      message?: string
      progress?: number
    }
  | {
      type: 'segment_final'
      source: AudioSource
      chunk_id: string
      start_at: number
      end_at: number
      text: string
      engine: string
      transcribe_ms: number
    }
  | { type: 'flushed'; id?: string | null }
  | { type: 'error'; source?: AudioSource; chunk_id?: string; engine?: string; message: string }

function emitLog(
  events: EventBus | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: unknown,
) {
  events?.publish({ type: 'log', at: Date.now(), level, message, extra })
}

export class NativeAsrTranscription implements TranscriptionEngine {
  readonly name: string
  private binary?: string
  private worker?: NativeWorker
  private callbacks?: TranscriptionCallbacks
  private readyCache?: boolean
  private sawStoppedStatus = false
  private flushes = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    family: AsrEngineFamily,
    private opts: AsrOptions = {},
    private events?: EventBus,
  ) {
    this.opts.model = normalizeAsrModel(family, opts.model)
    this.name = `${family}:${this.opts.model}`
  }

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = findNativeBinary('hpm-asr')
    this.readyCache = Boolean(this.binary)
    if (!this.readyCache) {
      emitLog(
        this.events,
        'error',
        'hpm-asr binary not found; run `bun run build` or `cargo build --release --workspace`',
      )
    }
    return this.readyCache
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    if (this.worker?.running) return
    const ok = await this.ready()
    if (!ok || !this.binary) throw new Error('hpm-asr binary not located')

    callbacks.onStatus({
      status: 'starting',
      engine: this.name,
      message: 'starting ASR worker',
    })
    this.sawStoppedStatus = false
    this.worker = new NativeWorker(this.binary, {
      onLine: (line) => this.handleLine(line),
      onStderr: (text) => emitLog(this.events, 'warn', `hpm-asr stderr: ${text}`),
      onError: (err) => {
        callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
        this.rejectFlushes(err)
      },
      onClose: (code) => {
        if (!this.sawStoppedStatus) {
          callbacks.onStatus({
            status: 'stopped',
            engine: this.name,
            message: `hpm-asr exited ${code}`,
          })
        }
        this.rejectFlushes(new Error(`hpm-asr exited ${code}`))
      },
    })
    this.worker.spawn()

    this.send({
      type: 'init',
      model: this.opts.model,
      language: this.opts.language,
      compute_type: this.opts.compute_type,
      sample_rate: 16000,
      min_segment_ms: this.opts.live?.min_segment_ms,
      target_segment_ms: this.opts.live?.target_segment_ms,
      max_segment_ms: this.opts.live?.max_segment_ms,
      silence_ms: this.opts.live?.silence_ms,
      rms_gate: this.opts.live?.rms_gate,
    })
  }

  submitPcm(frame: PcmAudioFrame): void {
    if (!this.worker?.running || this.opts.live?.enabled === false) return
    this.send({
      type: 'audio',
      source: frame.source,
      chunk_id: frame.chunkId,
      at: Math.round(frame.at),
      sample_rate: frame.sampleRate,
      pcm_b64: frame.pcm.toString('base64'),
    })
  }

  async flush(source?: AudioSource): Promise<void> {
    if (!this.worker?.running) return
    const id = randomUUIDv7()
    this.send({ type: 'flush', id, source })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id)
        reject(new Error(`hpm-asr flush timed out (${source ?? 'all'})`))
      }, 120_000)
      this.flushes.set(id, { resolve, reject, timer })
    })
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
      emitLog(this.events, 'warn', `invalid hpm-asr JSON: ${line.slice(0, 200)}`)
      return
    }
    this.handleMessage(msg)
  }

  private handleMessage(msg: WorkerMessage): void {
    if (!this.callbacks) return
    if (msg.type === 'ready') {
      this.callbacks.onStatus({
        status: 'ready',
        engine: msg.engine,
        message: `${msg.engine} ready`,
      })
    } else if (msg.type === 'status') {
      if (msg.status === 'stopped') this.sawStoppedStatus = true
      this.callbacks.onStatus({
        status: msg.status,
        engine: msg.engine ?? this.name,
        message: msg.message,
        progress: msg.progress,
      })
    } else if (msg.type === 'segment_final') {
      const text = msg.text.trim()
      if (!text) return
      const segment: TranscriptionSegment = {
        source: msg.source,
        chunkId: msg.chunk_id,
        startAt: msg.start_at,
        endAt: msg.end_at,
        text,
        engine: msg.engine,
        transcribeMs: msg.transcribe_ms,
      }
      this.callbacks.onSegment(segment)
    } else if (msg.type === 'flushed') {
      if (msg.id) this.resolveFlush(msg.id)
    } else if (msg.type === 'error') {
      const message = msg.message || 'hpm-asr error'
      this.callbacks.onStatus({ status: 'error', engine: msg.engine ?? this.name, message })
      emitLog(this.events, 'error', message, msg)
    }
  }

  private send(value: Record<string, unknown>): void {
    this.worker?.send(value)
  }

  private resolveFlush(id: string): void {
    const pending = this.flushes.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.flushes.delete(id)
    pending.resolve()
  }

  private rejectFlushes(err: Error): void {
    for (const [id, pending] of this.flushes) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.flushes.delete(id)
    }
  }
}
