// Settings field descriptors used by the web settings editor.
// settingsFields() reads process.platform, so it runs server-side; the web UI
// receives the resulting descriptors over /api/config.

import type { Config } from '../config'

type SettingKind = 'bool' | 'enum' | 'number' | 'text'
type SettingPath = readonly string[]

export interface SettingField {
  label: string
  path: SettingPath
  kind: SettingKind
  hint: string
  choices?: readonly unknown[]
  step?: number
  min?: number
  max?: number
}

function getSettingValue(config: Config, path: SettingPath): unknown {
  let cur: unknown = config
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// Kept in sync with SUPPORTED_TRANSCRIPTION_ENGINES in src/config.ts and with
// the model sets in src/process/transcription/native_asr.ts.
const ASR_ENGINES = ['parakeet', 'whisper'] as const
const PARAKEET_MODELS = ['parakeet-tdt-0.6b-v3'] as const
const WHISPER_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'whisper-medium',
  'whisper-small',
  'whisper-base',
  'whisper-tiny',
] as const

function modelsFor(engine: string): readonly string[] {
  return engine === 'whisper' ? WHISPER_MODELS : PARAKEET_MODELS
}

export function settingsFields(config: Config): SettingField[] {
  const txEngine = String(getSettingValue(config, ['processing', 'transcription', 'engine']))
  // No `compare` key means no second engine; 'off' is what the editor writes to
  // remove it again.
  const compareEngine = String(
    getSettingValue(config, ['processing', 'transcription', 'compare', 'engine']) ?? 'off',
  )
  return [
    {
      label: 'Screen capture',
      path: ['capture', 'screen', 'enabled'],
      kind: 'bool',
      hint: 'enable screenshots',
    },
    {
      label: 'Screen interval',
      path: ['capture', 'screen', 'interval_ms'],
      kind: 'number',
      step: 1000,
      min: 500,
      hint: 'milliseconds',
    },
    {
      label: 'Screen monitor',
      path: ['capture', 'screen', 'monitor'],
      kind: 'enum',
      choices: ['primary', 'all'],
      hint: 'monitor selection',
    },
    {
      label: 'Screen format',
      path: ['capture', 'screen', 'format'],
      kind: 'enum',
      choices: ['webp', 'jpg', 'png'],
      hint: 'image format',
    },
    {
      label: 'Screen quality',
      path: ['capture', 'screen', 'quality'],
      kind: 'number',
      step: 5,
      min: 1,
      max: 100,
      hint: 'lossy quality (webp/jpg)',
    },
    {
      label: 'Screen max width',
      path: ['capture', 'screen', 'max_width'],
      kind: 'number',
      step: 320,
      min: 0,
      hint: 'px, 0 = native resolution',
    },
    {
      label: 'Mic capture',
      path: ['capture', 'audio', 'mic', 'enabled'],
      kind: 'bool',
      hint: 'enable microphone',
    },
    {
      label: 'Mic device',
      path: ['capture', 'audio', 'mic', 'device'],
      kind: 'text',
      hint: 'device name or default',
    },
    {
      label: 'Mic chunk',
      path: ['capture', 'audio', 'mic', 'chunk_ms'],
      kind: 'number',
      step: 5000,
      min: 1000,
      hint: 'milliseconds',
    },
    {
      label: 'System audio',
      path: ['capture', 'audio', 'system', 'enabled'],
      kind: 'bool',
      hint: 'enable speaker/system audio',
    },
    {
      label: 'System device',
      path: ['capture', 'audio', 'system', 'device'],
      kind: 'text',
      hint: 'device name or default',
    },
    {
      label: 'System chunk',
      path: ['capture', 'audio', 'system', 'chunk_ms'],
      kind: 'number',
      step: 5000,
      min: 1000,
      hint: 'milliseconds',
    },
    {
      label: 'Sample rate',
      path: ['capture', 'audio', 'sample_rate'],
      kind: 'enum',
      choices: [16000, 24000, 44100, 48000],
      hint: 'Hz',
    },
    {
      label: 'Audio format',
      path: ['capture', 'audio', 'format'],
      kind: 'enum',
      choices: ['webm', 'wav'],
      hint: 'blob storage format',
    },
    {
      label: 'Opus bitrate',
      path: ['capture', 'audio', 'bitrate_kbps'],
      kind: 'number',
      step: 4,
      min: 6,
      max: 256,
      hint: 'kbps, webm only',
    },
    {
      label: 'Echo guard',
      path: ['capture', 'audio', 'echo_suppression', 'enabled'],
      kind: 'bool',
      hint: 'suppress speaker bleed in mic transcript',
    },
    {
      label: 'Speaker gate',
      path: ['capture', 'audio', 'echo_suppression', 'system_threshold_db'],
      kind: 'number',
      step: 1,
      min: -90,
      hint: 'mixer dB threshold',
    },
    {
      label: 'Mic margin',
      path: ['capture', 'audio', 'echo_suppression', 'mic_margin_db'],
      kind: 'number',
      step: 1,
      min: 0,
      hint: 'dB mic must beat mixer',
    },
    {
      label: 'Echo hold',
      path: ['capture', 'audio', 'echo_suppression', 'hold_ms'],
      kind: 'number',
      step: 100,
      min: 0,
      hint: 'ms after mixer activity',
    },
    {
      label: 'OCR engine',
      path: ['processing', 'ocr', 'engine'],
      kind: 'enum',
      choices: ['auto', 'tesseract', 'noop', 'hailo'],
      hint:
        'screen text engine; hailo needs the NPU and its HEF models',
    },
    {
      label: 'OCR language',
      path: ['processing', 'ocr', 'options', 'lang'],
      kind: 'text',
      hint: 'tesseract lang, e.g. eng/fra',
    },
    {
      label: 'OCR scale',
      path: ['processing', 'ocr', 'options', 'scale'],
      kind: 'number',
      step: 0.5,
      min: 0.5,
      max: 4,
      hint: 'hailo: upscale factor before OCR; 1 on large screens, 2 on small ones',
    },
    {
      label: 'OCR python',
      path: ['processing', 'ocr', 'options', 'python'],
      kind: 'text',
      hint:
        'hailo: python interpreter that runs the worker (absolute path to a venv python or plain python3)',
    },
    {
      label: 'Audio device',
      path: ['processing', 'transcription', 'device'],
      kind: 'enum',
      choices: ['gpu', 'cpu'],
      hint:
        txEngine === 'off' ? 'nothing to run' : 'gpu = ggml/Vulkan servers, cpu = hpm-asr worker',
    },
    {
      label: 'Audio engine',
      path: ['processing', 'transcription', 'engine'],
      kind: 'enum',
      choices: ['off', ...ASR_ENGINES],
      hint: 'live ASR engine, or off to stop transcribing',
    },
    {
      label: 'Audio model',
      path: ['processing', 'transcription', 'options', 'model'],
      kind: 'enum',
      choices: modelsFor(txEngine),
      hint: `${txEngine} model`,
    },
    {
      label: 'Audio language',
      path: ['processing', 'transcription', 'options', 'language'],
      kind: 'text',
      hint:
        txEngine === 'whisper'
          ? 'auto, or a code like fr/en'
          : 'Parakeet is multilingual, no hint needed',
    },
    {
      label: 'Compare engine',
      path: ['processing', 'transcription', 'compare', 'engine'],
      kind: 'enum',
      // The primary's own family is not offered: the same model twice produces
      // the same text and nothing to compare.
      choices: ['off', ...ASR_ENGINES.filter((engine) => engine !== txEngine)],
      hint: txEngine === 'off' ? 'needs a first engine' : 'second engine, shown beside the first',
    },
    {
      label: 'Compare model',
      path: ['processing', 'transcription', 'compare', 'options', 'model'],
      kind: 'enum',
      choices: modelsFor(compareEngine),
      hint: compareEngine === 'off' ? 'no second engine' : `${compareEngine} model to compare with`,
    },
    {
      label: 'Compare language',
      path: ['processing', 'transcription', 'compare', 'options', 'language'],
      kind: 'text',
      hint: compareEngine === 'whisper' ? 'auto, or a code like fr/en' : 'Whisper only',
    },
    {
      label: 'Live ASR',
      path: ['processing', 'transcription', 'options', 'live', 'enabled'],
      kind: 'bool',
      hint: 'stream partial transcript events',
    },
    {
      label: 'Min speech',
      path: ['processing', 'transcription', 'options', 'live', 'min_segment_ms'],
      kind: 'number',
      step: 250,
      min: 250,
      hint: 'ms before transcribing',
    },
    {
      label: 'Target speech',
      path: ['processing', 'transcription', 'options', 'live', 'target_segment_ms'],
      kind: 'number',
      step: 500,
      min: 1000,
      hint: 'live segment target ms',
    },
    {
      label: 'Max speech',
      path: ['processing', 'transcription', 'options', 'live', 'max_segment_ms'],
      kind: 'number',
      step: 500,
      min: 1500,
      hint: 'hard segment cap ms',
    },
    {
      label: 'Silence cut',
      path: ['processing', 'transcription', 'options', 'live', 'silence_ms'],
      kind: 'number',
      step: 100,
      min: 100,
      hint: 'ms silence closes segment',
    },
    {
      label: 'RMS gate',
      path: ['processing', 'transcription', 'options', 'live', 'rms_gate'],
      kind: 'number',
      step: 0.001,
      min: 0,
      hint: 'pre-VAD silence gate',
    },
    {
      label: 'Storage path',
      path: ['storage', 'path'],
      kind: 'text',
      hint: 'blob/index directory',
    },
  ]
}
