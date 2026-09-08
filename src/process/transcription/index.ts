import type { EngineConfig, TranscriptionConfig } from '../../config'
import type { EventBus } from '../../core/events'
import type { TranscriptionEngine, TranscriptionRole } from '../types'
import { DualTranscription } from './dual'
import {
  type AsrEngineFamily,
  type AsrOptions,
  NativeAsrTranscription,
  normalizeAsrModel,
} from './native_asr'

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

function asrOptionsFrom(
  family: AsrEngineFamily,
  opts: Record<string, unknown>,
  live: AsrOptions['live'],
): AsrOptions {
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
    live,
  }
}

function makeEngine(
  cfg: EngineConfig,
  live: AsrOptions['live'],
  role: TranscriptionRole,
  events?: EventBus,
): TranscriptionEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'whisper':
      return new NativeAsrTranscription(
        'whisper',
        asrOptionsFrom('whisper', opts, live),
        events,
        role,
      )
    case 'parakeet':
      return new NativeAsrTranscription(
        'parakeet',
        asrOptionsFrom('parakeet', opts, live),
        events,
        role,
      )
    default:
      throw new Error(`unknown transcription engine: ${cfg.engine}`)
  }
}

export function makeTranscription(
  cfg: TranscriptionConfig,
  events?: EventBus,
): TranscriptionEngine {
  // Both engines segment the audio with the primary's `live` settings, which is
  // what makes their segments comparable: same VAD, same boundaries, two
  // transcripts of the same speech.
  const live = liveOptionsFrom((cfg.options ?? {}).live)
  const primary = makeEngine(cfg, live, 'primary', events)
  const compare = cfg.compare
  if (!compare) return primary
  return new DualTranscription(primary, makeEngine(compare, live, 'compare', events), events)
}
