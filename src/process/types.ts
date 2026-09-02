import type { AudioSource } from '../core/events'

export interface OcrEngine {
  readonly name: string
  ready(): Promise<boolean>
  process(image: Buffer): Promise<string>
}

export interface PcmAudioFrame {
  source: AudioSource
  chunkId: string
  at: number
  sampleRate: number
  pcm: Buffer
}

export interface TranscriptionSegment {
  source: AudioSource
  chunkId: string
  startAt: number
  endAt: number
  text: string
  engine: string
  transcribeMs: number
}

export interface TranscriptionStatus {
  status: 'starting' | 'downloading' | 'loading' | 'ready' | 'error' | 'stopped'
  engine: string
  message?: string
  // 0–100 while a model is downloading; absent for other statuses.
  progress?: number
}

export interface TranscriptionCallbacks {
  onSegment(segment: TranscriptionSegment): void
  onStatus(status: TranscriptionStatus): void
}

export interface TranscriptionEngine {
  readonly name: string
  ready(): Promise<boolean>
  start(callbacks: TranscriptionCallbacks): Promise<void>
  submitPcm(frame: PcmAudioFrame): void
  flush(source?: AudioSource): Promise<void>
  stop(): Promise<void>
}

type EmbeddingKind = 'segment' | 'chunk' | 'query'

export interface EmbeddingRequest {
  id: string
  kind: EmbeddingKind
  text: string
}

export interface EmbeddingResult {
  id: string
  kind: EmbeddingKind
  vector: Float32Array
}

export interface EmbeddingStatus {
  status: 'starting' | 'downloading' | 'loading' | 'ready' | 'error' | 'stopped'
  engine: string
  message?: string
}

export interface EmbeddingCallbacks {
  onStatus(status: EmbeddingStatus): void
}

export interface EmbeddingEngine {
  readonly name: string
  readonly dim: number
  ready(): Promise<boolean>
  start(callbacks: EmbeddingCallbacks): Promise<void>
  // Resolves one EmbeddingResult per request id (order not guaranteed).
  embed(requests: EmbeddingRequest[]): Promise<EmbeddingResult[]>
  stop(): Promise<void>
}
