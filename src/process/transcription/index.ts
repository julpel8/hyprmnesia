import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EngineConfig, TranscriptionConfig, TranscriptionDevice } from '../../config'
import type { EventBus } from '../../core/events'
import type { TranscriptionEngine, TranscriptionRole } from '../types'
import { DualTranscription } from './dual'
import { GpuAsrTranscription } from './gpu_asr'
import { GpuAsrServer } from './gpu_server'
import {
  type AsrEngineFamily,
  type AsrOptions,
  NativeAsrTranscription,
  normalizeAsrModel,
} from './native_asr'
import { DisabledTranscription } from './off'
import type { SegmenterOptions } from './segmenter'

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

const SAMPLE_RATE = 16_000

function segmenterOptionsFrom(live: AsrOptions['live']): SegmenterOptions {
  return {
    sampleRate: SAMPLE_RATE,
    minSegmentMs: live?.min_segment_ms ?? 750,
    targetSegmentMs: live?.target_segment_ms ?? 4000,
    maxSegmentMs: live?.max_segment_ms ?? 6000,
    silenceMs: live?.silence_ms ?? 700,
    rmsGate: live?.rms_gate ?? 0.003,
  }
}

// GPU models live outside the Hugging Face cache: they are ggml/GGUF conversions
// that only these servers read, and `hpm setup-gpu-asr` puts them here.
export function gpuModelDir(): string {
  return join(homedir(), '.hyprmnesia', 'gpu-models')
}

// The logical model name in the config maps to a file per engine. Keeping the
// config names stable across devices means switching device does not rewrite
// the rest of the block.
const GPU_MODEL_FILES: Record<string, string> = {
  'parakeet-tdt-0.6b-v3': 'parakeet-tdt-0.6b-v3-q8_0.gguf',
  'whisper-large-v3-turbo': 'ggml-large-v3-turbo.bin',
  'whisper-large-v3': 'ggml-large-v3.bin',
  'whisper-medium': 'ggml-medium.bin',
  'whisper-small': 'ggml-small.bin',
  'whisper-base': 'ggml-base.bin',
  'whisper-tiny': 'ggml-tiny.bin',
}

// One port each, so the two engines can serve at the same time. Fixed rather
// than random because a leftover server from a crashed daemon is then reused
// instead of quietly doubling GPU memory.
const GPU_PORTS: Record<TranscriptionRole, number> = { primary: 8791, compare: 8792 }

function makeGpuEngine(
  family: AsrEngineFamily,
  opts: AsrOptions,
  live: AsrOptions['live'],
  role: TranscriptionRole,
  events?: EventBus,
): TranscriptionEngine {
  const binaryName = family === 'whisper' ? 'whisper-server' : 'parakeet-server'
  const binary = GpuAsrServer.locate(binaryName)
  if (!binary) {
    throw new Error(
      `${binaryName} not found in dist/native/gpu; run \`bun run scripts/setup-gpu-asr.ts\``,
    )
  }
  const model = GPU_MODEL_FILES[opts.model ?? '']
  if (!model) throw new Error(`no GPU model file known for ${opts.model}`)
  return new GpuAsrTranscription(
    {
      flavour: family,
      binary,
      model: join(gpuModelDir(), model),
      port: GPU_PORTS[role],
      // The ggml backends ship next to the executable rather than being
      // installed, so the loader is pointed at that directory.
      libraryPath: binary.slice(0, binary.lastIndexOf('/')),
      language: opts.language,
      segmenter: segmenterOptionsFrom(live),
      liveEnabled: live?.enabled,
    },
    events,
    role,
  )
}

function makeEngine(
  cfg: EngineConfig,
  device: TranscriptionDevice,
  live: AsrOptions['live'],
  role: TranscriptionRole,
  events?: EventBus,
): TranscriptionEngine {
  if (cfg.engine === 'off') return new DisabledTranscription()
  const opts = cfg.options ?? {}
  const family: AsrEngineFamily =
    cfg.engine === 'whisper'
      ? 'whisper'
      : cfg.engine === 'parakeet'
        ? 'parakeet'
        : (() => {
            throw new Error(`unknown transcription engine: ${cfg.engine}`)
          })()
  const asrOptions = asrOptionsFrom(family, opts, live)
  if (device === 'gpu') return makeGpuEngine(family, asrOptions, live, role, events)
  return new NativeAsrTranscription(family, asrOptions, events, role)
}

export function makeTranscription(
  cfg: TranscriptionConfig,
  events?: EventBus,
): TranscriptionEngine {
  // Both engines segment the audio with the primary's `live` settings, which is
  // what makes their segments comparable: same boundaries, two transcripts of
  // the same speech.
  const live = liveOptionsFrom((cfg.options ?? {}).live)
  const device: TranscriptionDevice = cfg.device === 'cpu' ? 'cpu' : 'gpu'
  const primary = makeEngine(cfg, device, live, 'primary', events)
  const compare = cfg.compare
  if (!compare) return primary
  return new DualTranscription(
    primary,
    makeEngine(compare, device, live, 'compare', events),
    events,
  )
}
