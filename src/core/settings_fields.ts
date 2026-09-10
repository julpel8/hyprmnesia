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

export function settingsFields(config: Config): SettingField[] {
  const ocrEngine = String(getSettingValue(config, ['processing', 'ocr', 'engine']))
  const nativeOcrPlatform = process.platform === 'win32' || process.platform === 'darwin'
  const txEngine = String(getSettingValue(config, ['processing', 'transcription', 'engine']))
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
      label: 'System backend',
      path: ['capture', 'audio', 'system', 'backend'],
      kind: 'enum',
      choices: ['auto', 'wasapi', 'dshow'],
      hint: 'windows: wasapi survives mute',
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
      choices: ['auto', 'native', 'tesseract', 'noop'],
      hint: 'screen text engine',
    },
    {
      label: 'OCR language',
      path: ['processing', 'ocr', 'options', 'lang'],
      kind: 'text',
      hint:
        ocrEngine === 'native' || (ocrEngine === 'auto' && nativeOcrPlatform)
          ? 'OS OCR auto-detects language'
          : 'tesseract lang, e.g. eng/fra',
    },
    {
      label: 'Audio engine',
      path: ['processing', 'transcription', 'engine'],
      kind: 'enum',
      choices: ['parakeet', 'noop'],
      hint: 'live ASR engine',
    },
    {
      label: 'Audio model',
      path: ['processing', 'transcription', 'options', 'model'],
      kind: 'enum',
      choices: ['parakeet-tdt-0.6b-v3'],
      hint: txEngine === 'noop' ? 'ignored by noop' : 'Parakeet model',
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
    {
      label: 'API bind',
      path: ['api', 'bind'],
      kind: 'text',
      hint: 'HTTP address, local only until auth',
    },
    {
      label: 'API port',
      path: ['api', 'port'],
      kind: 'number',
      step: 1,
      min: 1,
      max: 65535,
      hint: 'HTTP port',
    },
    {
      label: 'API auth',
      path: ['api', 'auth', 'enabled'],
      kind: 'bool',
      hint: 'require local token',
    },
  ]
}
