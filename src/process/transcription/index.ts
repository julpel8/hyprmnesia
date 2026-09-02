import type { EngineConfig } from '../../config'
import type { EventBus } from '../../core/events'
import type { TranscriptionEngine } from '../types'
import {
  type AsrEngineFamily,
  type AsrOptions,
  NativeAsrTranscription,
  normalizeAsrModel,
} from './native_asr'
import { NoopTranscription } from './noop'

function liveOptionsFrom(value: unknown): AsrOptions['live'] {
  if (!value || typeof value !== 'object') return undefined
  const live = value as Record<string, unknown>
  return {
    enabled: typeof live.enabled === 'boolean' ? live.enabled : undefined,
    min_segment_ms: typeof live.min_segment_ms === 'number' ? live.min_segment_ms : undefined,
    target_segment_ms:
      typeof live.target_segment_ms === 'number' ? live.target_segment_ms : undefined,
    max_segment_ms: typeof live.max_segment_ms === 'number' ? live.max_segment_ms : undefined,
    silence_ms: typeof live.silence_ms === 'number' ? live.silence_ms : undefined,
    rms_gate: typeof live.rms_gate === 'number' ? live.rms_gate : undefined,
  }
}

function asrOptionsFrom(family: AsrEngineFamily, opts: Record<string, unknown>): AsrOptions {
  return {
    model: normalizeAsrModel(family, opts.model),
    // Parakeet is multilingual without a language hint; only Whisper takes one.
    language:
      family === 'whisper' && typeof opts.language === 'string' && opts.language.trim() !== ''
        ? opts.language.trim()
        : undefined,
    // compute_type only applies to the Whisper (CTranslate2) backend.
    compute_type:
      family === 'whisper' && typeof opts.compute_type === 'string' ? opts.compute_type : undefined,
    live: liveOptionsFrom(opts.live),
  }
}

export function makeTranscription(cfg: EngineConfig, events?: EventBus): TranscriptionEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopTranscription()
    case 'whisper':
      return new NativeAsrTranscription('whisper', asrOptionsFrom('whisper', opts), events)
    case 'parakeet':
      return new NativeAsrTranscription('parakeet', asrOptionsFrom('parakeet', opts), events)
    default:
      throw new Error(`unknown transcription engine: ${cfg.engine}`)
  }
}
