// Drains un-embedded captures into vectors. A single polling loop covers both
// forward indexing (new OCR chunks + transcript segments) and backfill of
// historical rows: it asks the store for rows missing an embedding, encodes them
// in batches via the embedding worker, and writes the vectors back. Capture and
// transcription never wait on this; failures are logged best-effort.

import type { EventBus, Source } from '../core/events'
import type { ChunkStore, EmbeddingKind } from '../store/db'
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingStatus } from './types'

export interface EmbeddingQueueOptions {
  model: string
  dim: number
  batchSize: number
  sources: Source[]
}

const IDLE_SLEEP_MS = 5_000
const BUSY_SLEEP_MS = 250

export class EmbeddingQueue {
  private running = false
  private wake?: () => void
  private loopDone?: Promise<void>
  private embedChunks: boolean
  private embedSegments: boolean

  constructor(
    private engine: EmbeddingEngine,
    private store: ChunkStore,
    private events: EventBus,
    private opts: EmbeddingQueueOptions,
  ) {
    this.embedChunks = opts.sources.includes('screen')
    this.embedSegments = opts.sources.includes('mic') || opts.sources.includes('system')
  }

  async start(): Promise<void> {
    if (!this.store.vecEnabled) {
      this.log('info', 'semantic index unavailable (sqlite-vec not loaded); embeddings disabled')
      return
    }
    if (!(await this.engine.ready())) {
      this.log('info', `embedding engine '${this.engine.name}' not ready; embeddings disabled`)
      return
    }
    await this.engine.start({ onStatus: (status) => this.handleStatus(status) })
    this.running = true
    this.loopDone = this.loop()
  }

  async stop(): Promise<void> {
    if (!this.running) {
      await this.engine.stop().catch(() => {})
      return
    }
    this.running = false
    this.wake?.()
    await this.loopDone?.catch(() => {})
    await this.engine.stop().catch((err) => this.log('warn', `embed stop failed: ${err}`))
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let drained = 0
      try {
        drained = await this.drainOnce()
      } catch (err) {
        this.log('warn', `embedding drain failed: ${err}`)
      }
      if (!this.running) break
      await this.sleep(drained > 0 ? BUSY_SLEEP_MS : IDLE_SLEEP_MS)
    }
  }

  private async drainOnce(): Promise<number> {
    let total = 0
    if (this.embedSegments) total += await this.drainKind('segment')
    if (this.running && this.embedChunks) total += await this.drainKind('chunk')
    return total
  }

  private async drainKind(kind: EmbeddingKind): Promise<number> {
    const pending = this.store.pendingEmbeddings(kind, this.opts.model, this.opts.batchSize)
    if (pending.length === 0) return 0
    const requests: EmbeddingRequest[] = pending.map((row) => ({
      id: row.id,
      kind,
      text: row.text,
    }))
    const results = await this.engine.embed(requests)
    for (const result of results) {
      if (result.kind === 'query') continue
      this.store.insertEmbedding({
        kind: result.kind,
        id: result.id,
        vector: result.vector,
        model: this.opts.model,
        dim: this.opts.dim,
      })
    }
    return results.length
  }

  private handleStatus(status: EmbeddingStatus): void {
    this.events.publish({
      type: 'embedding_status',
      at: Date.now(),
      status: status.status,
      engine: status.engine,
      message: status.message,
    })
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
