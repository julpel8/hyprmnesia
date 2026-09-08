import type { AudioSource, EventBus } from '../../core/events'
import type {
  PcmAudioFrame,
  TranscriptionCallbacks,
  TranscriptionEngine,
  TranscriptionRole,
  TranscriptionSegment,
} from '../types'
import { GpuAsrServer, type GpuServerFlavour } from './gpu_server'
import {
  type PendingSegment,
  pcmToFloat32,
  Segmenter,
  type SegmenterOptions,
  samplesToWav,
} from './segmenter'

// A transcription engine backed by a ggml/Vulkan server, so the model runs on
// the GPU instead of the CPU. Segmentation happens here rather than in the
// server: both engines must see the same stretches of speech for their
// transcripts to be comparable, and the servers have no shared VAD.
//
// Segments are transcribed one at a time. The GPU is a single resource, and
// queueing keeps a burst of speech from launching a dozen overlapping requests
// that would each be slower than running them in order.

export interface GpuAsrOptions {
  flavour: GpuServerFlavour
  binary: string
  model: string
  port: number
  libraryPath?: string
  threads?: number
  language?: string
  segmenter: SegmenterOptions
  liveEnabled?: boolean
}

export class GpuAsrTranscription implements TranscriptionEngine {
  readonly name: string
  private server: GpuAsrServer
  private segmenter: Segmenter
  private callbacks?: TranscriptionCallbacks
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly opts: GpuAsrOptions,
    private readonly events?: EventBus,
    private readonly role: TranscriptionRole = 'primary',
  ) {
    this.server = new GpuAsrServer({
      flavour: opts.flavour,
      binary: opts.binary,
      model: opts.model,
      port: opts.port,
      libraryPath: opts.libraryPath,
      threads: opts.threads,
      language: opts.language,
      onLog: (level, message) => this.log(level, message),
    })
    this.segmenter = new Segmenter(opts.segmenter)
    this.name = this.server.name
  }

  async ready(): Promise<boolean> {
    return true
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    callbacks.onStatus({
      status: 'starting',
      engine: this.name,
      message: 'starting GPU ASR server',
    })
    try {
      await this.server.start()
    } catch (err) {
      callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
      throw err
    }
    callbacks.onStatus({ status: 'ready', engine: this.name, message: `${this.name} ready` })
  }

  submitPcm(frame: PcmAudioFrame): void {
    if (this.opts.liveEnabled === false || !this.server.running) return
    const samples = pcmToFloat32(frame.pcm)
    for (const segment of this.segmenter.push(
      frame.source,
      frame.chunkId,
      Math.round(frame.at),
      samples,
    )) {
      this.enqueue(segment)
    }
  }

  async flush(source?: AudioSource): Promise<void> {
    for (const segment of this.segmenter.flush(source)) this.enqueue(segment)
    // Resolving only once the queue has drained is what makes a flush mean
    // "everything spoken so far has been transcribed".
    await this.queue
  }

  async stop(): Promise<void> {
    await this.flush().catch(() => {})
    await this.server.stop()
    this.callbacks?.onStatus({ status: 'stopped', engine: this.name })
  }

  private enqueue(segment: PendingSegment): void {
    this.queue = this.queue.then(() => this.transcribe(segment)).catch(() => {})
  }

  private async transcribe(segment: PendingSegment): Promise<void> {
    if (!this.callbacks) return
    const started = Date.now()
    const wav = samplesToWav(segment.samples, this.opts.segmenter.sampleRate)
    let text: string
    try {
      text = await this.server.transcribe(wav)
    } catch (err) {
      this.callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
      this.log('error', `${this.name} transcription failed: ${err}`)
      return
    }
    if (!text) return

    const result: TranscriptionSegment = {
      source: segment.source,
      chunkId: segment.chunkId,
      startAt: segment.startAt,
      endAt: segment.endAt,
      text,
      engine: this.name,
      transcribeMs: Date.now() - started,
      role: this.role,
    }
    this.callbacks.onSegment(result)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.events?.publish({ type: 'log', at: Date.now(), level, message })
  }
}
