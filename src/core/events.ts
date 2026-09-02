import { EventEmitter } from 'node:events'

export type Source = 'screen' | 'mic' | 'system'
export type AudioSource = Exclude<Source, 'screen'>

export interface WindowContext {
  app: string
  title: string
  url?: string
  pid?: number
}

export type CaptureEvent =
  | { type: 'started'; source: Source; at: number; meta?: Record<string, unknown> }
  | { type: 'stopped'; source: Source; at: number }
  | {
      type: 'chunk'
      source: Source
      at: number
      id: string
      path: string
      bytes: number
      text_len: number
      capture_ms: number
      window?: WindowContext
      rms_db?: number
      peak_db?: number
    }
  | { type: 'window_changed'; at: number; window: WindowContext; previous?: WindowContext }
  | { type: 'audio_level'; source: Source; at: number; rms_db: number }
  | {
      type: 'transcription_status'
      at: number
      status: 'starting' | 'downloading' | 'loading' | 'ready' | 'error' | 'stopped'
      engine: string
      message?: string
      // 0–100 while a model is downloading; absent for other statuses.
      progress?: number
    }
  | {
      type: 'transcription_segment'
      source: AudioSource
      at: number
      id: string
      chunk_id: string
      start_at: number
      end_at: number
      text: string
      text_len: number
      transcribe_ms: number
      engine: string
    }
  | {
      type: 'transcribed'
      source: AudioSource // "mic" | "system"
      at: number // when transcription finished
      id: string // chunk id the text belongs to
      text: string // transcription text for live UI/log consumers
      text_len: number
      transcribe_ms: number
      engine: string
    }
  | {
      type: 'embedding_status'
      at: number
      status: 'starting' | 'downloading' | 'loading' | 'ready' | 'error' | 'stopped'
      engine: string
      message?: string
    }
  | { type: 'error'; source: Source; at: number; message: string }
  | { type: 'log'; at: number; level: 'info' | 'warn' | 'error'; message: string; extra?: unknown }

export type EventListener = (payload: CaptureEvent) => void

export class EventBus extends EventEmitter {
  publish(event: CaptureEvent) {
    this.emit('event', event)
  }
  subscribe(listener: EventListener): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }
}
