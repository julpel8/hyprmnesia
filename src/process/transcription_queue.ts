// Bridges live PCM frames into the ASR engine and persists final transcript
// segments. Capture never waits on transcription; the engine owns its own
// worker/process and emits final segments back through callbacks.

import { randomUUIDv7 } from 'bun'
import type { AudioSource, EventBus } from '../core/events'
import { isReplayTranscriptionSuppressed } from '../core/transcription_suppression'
import type { ChunkStore } from '../store/db'
import type {
  PcmAudioFrame,
  TranscriptionEngine,
  TranscriptionSegment,
  TranscriptionStatus,
} from './types'

export class TranscriptionQueue {
  private suppressedSources = new Set<AudioSource>()

  constructor(
    private engine: TranscriptionEngine,
    private store: ChunkStore,
    private events: EventBus,
    private opts: { isReplaySuppressed?: () => boolean } = {},
  ) {}

  async start(): Promise<void> {
    await this.engine.start({
      onSegment: (segment) => this.handleSegment(segment),
      onStatus: (status) => this.handleStatus(status),
    })
  }

  submitPcm(frame: PcmAudioFrame): void {
    const suppressed = this.opts.isReplaySuppressed?.() ?? isReplayTranscriptionSuppressed()
    if (suppressed) {
      if (!this.suppressedSources.has(frame.source)) {
        this.suppressedSources.add(frame.source)
        this.engine.flush(frame.source).catch((err) => {
          this.events.publish({
            type: 'log',
            at: Date.now(),
            level: 'warn',
            message: `ASR flush failed while suppressing replay transcription: ${err}`,
          })
        })
        this.events.publish({
          type: 'log',
          at: Date.now(),
          level: 'info',
          message: `ASR ${frame.source} suppressed while replay audio is playing`,
        })
      }
      return
    }
    this.suppressedSources.clear()
    this.engine.submitPcm(frame)
  }

  async flush(source?: AudioSource): Promise<void> {
    await this.engine.flush(source)
  }

  async stop(): Promise<void> {
    await this.engine.flush().catch((err) => {
      this.events.publish({
        type: 'log',
        at: Date.now(),
        level: 'warn',
        message: `ASR flush failed during stop: ${err}`,
      })
    })
    await this.engine.stop().catch((err) => {
      this.events.publish({
        type: 'log',
        at: Date.now(),
        level: 'warn',
        message: `ASR stop failed: ${err}`,
      })
    })
  }

  private handleStatus(status: TranscriptionStatus): void {
    this.events.publish({
      type: 'transcription_status',
      at: Date.now(),
      status: status.status,
      engine: status.engine,
      message: status.message,
      progress: status.progress,
    })
  }

  private handleSegment(segment: TranscriptionSegment): void {
    const id = randomUUIDv7()
    const text = segment.text.trim()
    if (!text) return

    try {
      this.store.insertTranscriptSegment({
        id,
        chunk_id: segment.chunkId,
        source: segment.source,
        start_at: segment.startAt,
        end_at: segment.endAt,
        text,
        engine: segment.engine,
        transcribe_ms: segment.transcribeMs,
        role: segment.role,
      })
    } catch (err) {
      this.events.publish({
        type: 'error',
        source: segment.source,
        at: Date.now(),
        message: `transcript segment insert failed for ${segment.chunkId}: ${err}`,
      })
      return
    }

    this.events.publish({
      type: 'transcription_segment',
      source: segment.source,
      at: Date.now(),
      id,
      chunk_id: segment.chunkId,
      start_at: segment.startAt,
      end_at: segment.endAt,
      text,
      text_len: text.length,
      transcribe_ms: segment.transcribeMs,
      engine: segment.engine,
      role: segment.role,
    })

    // Compatibility event for existing log consumers that expect final
    // chunk text on `transcribed`. It carries no role, and consumers key it by
    // chunk id, so only the primary transcript is published here; the compare
    // engine is visible on `transcription_segment` alone.
    if (segment.role !== 'primary') return
    this.events.publish({
      type: 'transcribed',
      source: segment.source,
      at: Date.now(),
      id: segment.chunkId,
      text,
      text_len: text.length,
      transcribe_ms: segment.transcribeMs,
      engine: segment.engine,
    })
  }
}
