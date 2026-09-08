import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, extname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { clampInt } from './util/num'
import { defaultConfigPath, expandHome, legacyConfigPath } from './util/paths'

export interface ScreenCaptureConfig {
  enabled: boolean
  interval_ms: number
  monitor: 'primary' | 'all' | number
  format: 'png' | 'jpg' | 'webp'
  // Lossy quality (1-100). Used by JPEG and WebP; ignored when format is png.
  quality: number
  // Downscale captures to fit this width in pixels; 0 keeps native resolution.
  max_width: number
}

type AudioStorageFormat = 'webm' | 'wav'

export interface AudioStreamConfig {
  enabled: boolean
  device: string
  chunk_ms: number
}

export interface AudioCaptureConfig {
  sample_rate: number
  // Stored audio blob format. The ASR pipeline still receives raw PCM.
  format: AudioStorageFormat
  // Opus bitrate in kbps when format is webm. Ignored for wav.
  bitrate_kbps: number
  echo_suppression: {
    enabled: boolean
    system_threshold_db: number
    mic_margin_db: number
    hold_ms: number
  }
  mic: AudioStreamConfig
  system: AudioStreamConfig
}

export interface EngineConfig {
  engine: string
  options?: Record<string, unknown>
}

// 'cpu' runs the bundled hpm-asr worker (CTranslate2 for Whisper, ONNX for
// Parakeet). 'gpu' runs the ggml servers on Vulkan, which reaches an Intel,
// AMD or NVIDIA GPU through the one backend.
export type TranscriptionDevice = 'cpu' | 'gpu'

export interface TranscriptionConfig extends EngineConfig {
  // Where both engines run. The compare engine never gets its own device: two
  // models on one GPU already share it, and splitting them across devices would
  // make their timings meaningless next to each other.
  device?: TranscriptionDevice

  // Second ASR engine fed the very same PCM frames as `engine`, so the two
  // transcripts can be read side by side in Live and Replay. Absent means no
  // second engine; there is no off switch to set, the key is simply not there.
  // Its segments are stored and displayed but never feed chunk text, search or
  // embeddings: the primary engine stays the one the recording says.
  compare?: EngineConfig
}

export interface UpdateConfig {
  // Check GitHub Releases for a newer version on `hpm start` and notify only —
  // never auto-install. Disable here, or set HPM_NO_UPDATE_CHECK=1 / run under
  // CI. `hpm update` checks on demand regardless of this flag.
  check: boolean
}

export interface StorageConfig {
  // Root of the Syncthing-shared tree. Each machine owns exactly one
  // subdirectory under it, named after `host_id`, and treats the others as
  // read-only.
  path: string
  // Name of this machine's subdirectory. Must be unique across the machines
  // sharing the folder, otherwise two daemons would write the same files.
  host_id: string
  // How often the live index DB is republished as a snapshot for the other
  // machines to read.
  snapshot_interval_minutes: number
}

export interface Config {
  schema_version: number
  capture: {
    screen: ScreenCaptureConfig
    audio: AudioCaptureConfig
  }
  processing: {
    ocr: EngineConfig
    transcription: TranscriptionConfig
    embeddings: EngineConfig
  }
  storage: StorageConfig
  update: UpdateConfig
}

export const CURRENT_CONFIG_SCHEMA_VERSION = 7

// Storage layout before the multi-machine split. A config still pointing there
// would silently keep writing outside the shared tree, so we refuse it instead
// of migrating: there is no upgrade path, the data directory starts fresh.
const LEGACY_STORAGE_PATH = '~/.hyprmnesia/data'

// A host id becomes a directory name and travels to every other machine, so
// keep it to lowercase ASCII, digits and dashes.
function sanitizeHostId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return cleaned === '' ? 'host' : cleaned
}

function defaultHostId(): string {
  try {
    return sanitizeHostId(hostname())
  } catch {
    return 'host'
  }
}

const defaultConfig: Config = {
  schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
  capture: {
    screen: {
      enabled: true,
      interval_ms: 5000,
      monitor: 'primary',
      format: 'webp',
      quality: 80,
      max_width: 0,
    },
    audio: {
      sample_rate: 16000,
      format: 'webm',
      bitrate_kbps: 24,
      echo_suppression: {
        enabled: true,
        system_threshold_db: -45,
        mic_margin_db: 6,
        hold_ms: 500,
      },
      mic: { enabled: true, device: 'default', chunk_ms: 5000 },
      system: { enabled: true, device: 'default', chunk_ms: 5000 },
    },
  },
  processing: {
    ocr: { engine: 'auto', options: { lang: 'eng' } },
    transcription: {
      // Parakeet (audiopipe/ONNX) is the default on every OS: it is far lighter
      // than whisper-large and stays usable on CPU, where the Whisper backend
      // (CTranslate2, CPU-only build) is too slow for live transcription.
      engine: 'parakeet',
      options: {
        model: 'parakeet-tdt-0.6b-v3',
        live: {
          enabled: true,
          min_segment_ms: 750,
          target_segment_ms: 4000,
          max_segment_ms: 6000,
          silence_ms: 700,
          rms_gate: 0.003,
        },
      },
      // Vulkan by default: the CPU path takes several times longer than the
      // audio it transcribes on anything but Parakeet.
      device: 'gpu',
      // No `compare` key by default: a second engine doubles model memory and
      // CPU per segment, so it only exists once someone adds it.
    },
    embeddings: {
      engine: 'local',
      options: {
        model: 'multilingual-e5-small',
        dim: 384,
        batch_size: 16,
        sources: ['screen', 'mic', 'system'],
      },
    },
  },
  storage: {
    path: '~/hyprmnesia-sync',
    host_id: defaultHostId(),
    snapshot_interval_minutes: 5,
  },
  update: {
    check: true,
  },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const DEFAULT_WHISPER_MODEL = 'whisper-large-v3-turbo'
const DEFAULT_WHISPER_LANGUAGE = 'auto'
const WHISPER_MODELS = new Set([
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'whisper-medium',
  'whisper-small',
  'whisper-base',
  'whisper-tiny',
])
// CTranslate2 quantization types accepted for the Whisper (faster-whisper)
// backend; mirrors parse_compute_type in asr/src/main.rs. Unknown values fall
// back to DEFAULT_WHISPER_COMPUTE_TYPE (CPU-safe int8; the float16 variants need
// GPU-class FP16 support).
const DEFAULT_WHISPER_COMPUTE_TYPE = 'int8'
const WHISPER_COMPUTE_TYPES = new Set([
  'int8',
  'int8_float16',
  'int8_float32',
  'int8_bfloat16',
  'int16',
  'float16',
  'bfloat16',
  'float32',
  'auto',
  'default',
])
// faster-whisper has no quantized -q5 variants (that was a whisper.cpp/GGML
// concept). Map the retired -q5 names onto their CTranslate2 base model.
const LEGACY_WHISPER_MODEL_REMAP: Record<string, string> = {
  'whisper-large-v3-turbo-q5': 'whisper-large-v3-turbo',
  'whisper-large-v3-q5': 'whisper-large-v3',
}
const DEFAULT_PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3'
const LEGACY_TRANSCRIPTION_ENGINES = new Set(['auto'])
// The two real engines. 'off' is accepted alongside them and means no
// transcription at all: audio is still captured and stored, nothing is
// transcribed. The retired 'noop' name maps onto it.
const ASR_ENGINES = new Set(['whisper', 'parakeet'])
const SUPPORTED_TRANSCRIPTION_ENGINES = new Set([...ASR_ENGINES, 'off'])
// A second engine can only be a real one: 'off' there means the `compare` key
// is dropped and a single engine runs.
const COMPARE_ENGINES = ASR_ENGINES

const DEFAULT_EMBEDDING_MODEL = 'multilingual-e5-small'
const DEFAULT_EMBEDDING_DIM = 384
const SUPPORTED_EMBEDDING_ENGINES = new Set(['local', 'noop'])

// Clones the base rather than sharing its nested objects: a loaded config is
// edited in place by `hpm` flags, the settings editor, and the audio switches,
// and those writes must not reach `defaultConfig`.
function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (typeof base !== 'object' || base === null) {
    if (override === null || override === undefined) return base
    return (override as T) ?? base
  }
  if (override === null || override === undefined) return structuredClone(base)
  const out: Record<string, unknown> = structuredClone(base) as Record<string, unknown>
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v as DeepPartial<unknown>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

export function loadConfig(path?: string): Config {
  const merged = loadMergedConfig(path)
  merged.storage.path = expandHome(merged.storage.path)
  return merged
}

export function loadConfigForEditing(path?: string): Config {
  return loadMergedConfig(path)
}

function loadMergedConfig(path?: string): Config {
  const p = resolveConfigPath(path)
  ensureConfigFile(p)
  const raw = readFileSync(p, 'utf8')
  const parsed = parseConfig(raw, p)
  migrateConfig(parsed, p)
  return normalizeConfig(deepMerge(defaultConfig, parsed))
}

function configSchemaVersion(parsed: DeepPartial<Config>, path: string): number {
  const version = (parsed as { schema_version?: unknown }).schema_version
  if (version === undefined) return 0
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`invalid config schema_version in ${path}: ${String(version)}`)
  }
  if (version > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config schema_version ${version} in ${path} is newer than supported schema_version ${CURRENT_CONFIG_SCHEMA_VERSION}`,
    )
  }
  return version
}

function migrateConfig(parsed: DeepPartial<Config>, path: string): void {
  const version = configSchemaVersion(parsed, path)
  if (version === 0) migrateConfigV0ToV1(parsed)
  if (version <= 1) migrateConfigV1ToV2(parsed)
  if (version <= 2) migrateConfigV2ToV3(parsed)
  if (version <= 3) migrateConfigV3ToV4(parsed)
  if (version <= 4) migrateConfigV4ToV5(parsed)
  if (version <= 5) migrateConfigV5ToV6(parsed)
  if (version <= 6) migrateConfigV6ToV7(parsed)
}

// v0 carried a legacy `storage.encryption.enabled` flag. Encryption is gone, so
// there is nothing left to map: v4->v5 drops the whole block.
function migrateConfigV0ToV1(parsed: DeepPartial<Config>): void {
  parsed.schema_version = 1
}

// Whisper becomes the default transcription engine. v1's normalizeConfig
// force-wrote `engine: parakeet` into every saved config, so a v1 file saying
// parakeet cannot express a deliberate choice — migrate it (and the legacy
// 'auto'/'whisper' names) to the new whisper default. Only 'noop' is an
// explicit opt-out worth preserving. Under v2, `engine: parakeet` is respected.
function migrateConfigV1ToV2(parsed: DeepPartial<Config>): void {
  const tx = parsed.processing?.transcription as
    | { engine?: unknown; options?: Record<string, unknown> }
    | undefined
  if (tx && tx.engine !== 'noop') {
    tx.engine = 'whisper'
    tx.options ??= {}
    tx.options.model = DEFAULT_WHISPER_MODEL
    if (typeof tx.options.language !== 'string') tx.options.language = DEFAULT_WHISPER_LANGUAGE
  }
  parsed.schema_version = 2
}

// Whisper moves from whisper.cpp/GGML to faster-whisper (CTranslate2). The
// quantized `*-q5` models no longer exist, so remap them to their base
// CTranslate2 model, and seed `compute_type` (CTranslate2 quantization) for
// configs that predate the option.
function migrateConfigV2ToV3(parsed: DeepPartial<Config>): void {
  const tx = parsed.processing?.transcription as
    | { engine?: unknown; options?: Record<string, unknown> }
    | undefined
  if (tx && tx.engine !== 'noop') {
    tx.options ??= {}
    if (typeof tx.options.model === 'string' && tx.options.model in LEGACY_WHISPER_MODEL_REMAP) {
      tx.options.model = LEGACY_WHISPER_MODEL_REMAP[tx.options.model]
    }
    if (typeof tx.options.compute_type !== 'string') {
      tx.options.compute_type = DEFAULT_WHISPER_COMPUTE_TYPE
    }
  }
  parsed.schema_version = 3
}

// Parakeet returns as the default transcription engine on every OS. The v1->v2
// migration force-wrote `engine: whisper` into every non-noop config, so a v3
// file saying whisper cannot express a deliberate choice — flip it (and the
// legacy 'auto' name) back to the parakeet default. Whisper-on-CPU (the only
// CTranslate2 build we ship) is too slow for live transcription, while Parakeet
// stays usable without a GPU. 'noop' was the explicit opt-out at the time and is
// preserved here for the later steps to see; it is no longer a real engine, so
// normalizeConfig maps it to the default. normalizeConfig then drops the
// whisper-only language/compute_type options and pins the parakeet model.
function migrateConfigV3ToV4(parsed: DeepPartial<Config>): void {
  const tx = parsed.processing?.transcription as
    | { engine?: unknown; options?: Record<string, unknown> }
    | undefined
  if (tx && tx.engine !== 'noop') {
    tx.engine = 'parakeet'
    tx.options ??= {}
    tx.options.model = DEFAULT_PARAKEET_MODEL
  }
  parsed.schema_version = 4
}

// Multi-device sync and at-rest encryption are gone. Drop their config blocks so
// a migrated file no longer carries settings nothing reads.
function migrateConfigV4ToV5(parsed: DeepPartial<Config>): void {
  const raw = parsed as Record<string, unknown>
  delete raw.sync
  const storage = raw.storage as Record<string, unknown> | undefined
  if (storage) delete storage.encryption
  parsed.schema_version = 5
}

// The protocol server is gone (replaced by the local UI's REST API); drop its
// config block so a migrated file no longer carries settings nothing reads.
function migrateConfigV5ToV6(parsed: DeepPartial<Config>): void {
  const raw = parsed as Record<string, unknown>
  delete raw.mcp
  parsed.schema_version = 6
}

// A second ASR engine can now run alongside the first, named by
// `processing.transcription.compare`. Nothing to migrate: a file without the key
// has no second engine, which is the default. The short-lived v7 files that
// carried `compare: { engine: noop }` are cleaned up by normalizeConfig.
function migrateConfigV6ToV7(parsed: DeepPartial<Config>): void {
  parsed.schema_version = CURRENT_CONFIG_SCHEMA_VERSION
}

// Model/language/compute_type rules for one ASR engine slot. Shared by the
// primary engine and the optional compare engine, which accept the same options
// because they run the same worker binary.
function normalizeTranscriptionEngine(slot: EngineConfig): void {
  // 'noop' was what turning transcription off used to be called.
  if (slot.engine === 'noop') slot.engine = 'off'
  if (LEGACY_TRANSCRIPTION_ENGINES.has(slot.engine)) slot.engine = 'parakeet'
  if (!SUPPORTED_TRANSCRIPTION_ENGINES.has(slot.engine)) slot.engine = 'parakeet'
  if (slot.engine === 'off') return
  slot.options ??= {}
  const options = slot.options
  if (slot.engine === 'whisper') {
    // Tolerate configs that still carry a retired -q5 name (e.g. saved before
    // the v2->v3 migration touched them) by remapping to the base model.
    if (typeof options.model === 'string' && options.model in LEGACY_WHISPER_MODEL_REMAP) {
      options.model = LEGACY_WHISPER_MODEL_REMAP[options.model]
    }
    if (typeof options.model !== 'string' || !WHISPER_MODELS.has(options.model)) {
      options.model = DEFAULT_WHISPER_MODEL
    }
    if (typeof options.language !== 'string' || options.language.trim() === '') {
      options.language = DEFAULT_WHISPER_LANGUAGE
    } else {
      options.language = options.language.trim()
    }
    if (
      typeof options.compute_type !== 'string' ||
      !WHISPER_COMPUTE_TYPES.has(options.compute_type)
    ) {
      options.compute_type = DEFAULT_WHISPER_COMPUTE_TYPE
    }
  } else {
    if (options.model !== DEFAULT_PARAKEET_MODEL) options.model = DEFAULT_PARAKEET_MODEL
    delete options.language
    delete options.compute_type
  }
}

// There is no second engine unless `compare` names one. The key is dropped when
// it is empty, when it is turned off, and when it names the primary's own family
// (two runs of the same model produce the same text and would collide on the
// `engine` recorded per segment). Segmentation is deliberately not configurable
// here: both engines share the primary's `live` settings so their segments line
// up and can be read as pairs.
function normalizeCompare(tx: TranscriptionConfig): void {
  const compare = tx.compare
  // Nothing to compare against when the first engine is off either.
  if (
    tx.engine === 'off' ||
    !compare ||
    typeof compare !== 'object' ||
    !COMPARE_ENGINES.has(compare.engine)
  ) {
    delete tx.compare
    return
  }
  normalizeTranscriptionEngine(compare)
  if (compare.engine === tx.engine) {
    delete tx.compare
    return
  }
  compare.options ??= {}
  delete compare.options.live
}

function normalizeConfig(config: Config): Config {
  config.schema_version = CURRENT_CONFIG_SCHEMA_VERSION

  const storage = config.storage
  if (typeof storage.path !== 'string' || storage.path.trim() === '') {
    storage.path = defaultConfig.storage.path
  }
  storage.path = storage.path.trim()
  if (storage.path === LEGACY_STORAGE_PATH) {
    throw new Error(
      `storage.path is still ${LEGACY_STORAGE_PATH}, the single-machine layout that this version replaced. ` +
        'There is no migration: stop the daemon, delete ~/.hyprmnesia/config.yaml, ~/.hyprmnesia/index.db* ' +
        'and ~/.hyprmnesia/data, then start again.',
    )
  }
  storage.host_id = sanitizeHostId(typeof storage.host_id === 'string' ? storage.host_id : '')
  if (storage.host_id === 'host') storage.host_id = defaultHostId()
  storage.snapshot_interval_minutes = clampInt(
    storage.snapshot_interval_minutes,
    1,
    1440,
    defaultConfig.storage.snapshot_interval_minutes,
  )

  const screen = config.capture.screen
  if (screen.format !== 'png' && screen.format !== 'jpg' && screen.format !== 'webp')
    screen.format = 'webp'
  screen.quality = clampInt(screen.quality, 1, 100, defaultConfig.capture.screen.quality)
  if (!Number.isFinite(screen.max_width) || screen.max_width < 0) screen.max_width = 0
  screen.max_width = Math.trunc(screen.max_width)

  const audio = config.capture.audio
  if (audio.format !== 'webm' && audio.format !== 'wav') audio.format = 'webm'
  audio.bitrate_kbps = clampInt(
    audio.bitrate_kbps,
    6,
    256,
    defaultConfig.capture.audio.bitrate_kbps,
  )

  const tx = config.processing.transcription
  if (tx.device !== 'cpu' && tx.device !== 'gpu') tx.device = 'gpu'
  normalizeTranscriptionEngine(tx)
  tx.options ??= {}
  // The segmentation settings are kept even when transcription is off, so
  // turning it back on does not start from defaults.
  tx.options.live = deepMerge(
    (defaultConfig.processing.transcription.options?.live ?? {}) as Record<string, unknown>,
    (tx.options.live && typeof tx.options.live === 'object' ? tx.options.live : {}) as Record<
      string,
      unknown
    >,
  )
  normalizeCompare(tx)
  const emb = config.processing.embeddings
  if (!emb || typeof emb !== 'object') {
    config.processing.embeddings = deepMerge(defaultConfig.processing.embeddings, {})
  } else {
    if (!SUPPORTED_EMBEDDING_ENGINES.has(emb.engine)) emb.engine = 'local'
    if (emb.engine === 'local') {
      emb.options ??= {}
      // v1 locks the model/dim pair; the vec0 schema is built for 384 dims.
      emb.options.model = DEFAULT_EMBEDDING_MODEL
      emb.options.dim = DEFAULT_EMBEDDING_DIM
    }
  }

  if (!config.update || typeof config.update !== 'object') {
    config.update = { ...defaultConfig.update }
  }
  if (typeof config.update.check !== 'boolean') {
    config.update.check = defaultConfig.update.check
  }
  return config
}

export function saveConfig(config: Config, path?: string): void {
  const p = resolveConfigPath(path)
  mkdirSync(dirname(p), { recursive: true })
  backupLegacyConfigIfNeeded(p)
  writeFileSync(p, serializeConfig({ ...config, schema_version: CURRENT_CONFIG_SCHEMA_VERSION }, p))
}

export function ensureDefaultConfig(path?: string): string {
  const p = resolveConfigPath(path)
  ensureConfigFile(p)
  return p
}

function configToYaml(config: Config = defaultConfig): string {
  return `# Hyprmnesia configuration\n# Changes apply after restarting the related daemon.\n\n${stringifyYaml(config)}`
}

function resolveConfigPath(path?: string): string {
  return expandHome(path ?? defaultConfigPath())
}

function parseConfig(raw: string, path: string): DeepPartial<Config> {
  if (extname(path).toLowerCase() === '.json') return JSON.parse(raw) as DeepPartial<Config>
  return (parseYaml(raw) ?? {}) as DeepPartial<Config>
}

function serializeConfig(config: Config, path: string): string {
  if (extname(path).toLowerCase() === '.json') return `${JSON.stringify(config, null, 2)}\n`
  return configToYaml(config)
}

function backupLegacyConfigIfNeeded(path: string): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  const parsed = parseConfig(raw, path)
  const fromVersion = configSchemaVersion(parsed, path)
  if (fromVersion >= CURRENT_CONFIG_SCHEMA_VERSION) return
  copyFileSync(path, legacyConfigBackupPath(path, fromVersion))
}

function legacyConfigBackupPath(path: string, fromVersion: number, date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '')
  return `${path}.v${fromVersion}-to-v${CURRENT_CONFIG_SCHEMA_VERSION}.${stamp}.bak`
}

function ensureConfigFile(path: string): void {
  if (existsSync(path)) return

  // Smooth migration path: if the old JSON default exists, create the YAML
  // default from its merged values and keep the JSON untouched.
  if (path === defaultConfigPath() && existsSync(legacyConfigPath())) {
    const legacyRaw = readFileSync(legacyConfigPath(), 'utf8')
    const parsed = parseConfig(legacyRaw, legacyConfigPath())
    migrateConfig(parsed, legacyConfigPath())
    const legacy = normalizeConfig(deepMerge(defaultConfig, parsed))
    saveConfig(legacy, path)
    return
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeConfig(defaultConfig, path))
}
