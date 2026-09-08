import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  loadConfig,
  loadConfigForEditing,
  saveConfig,
} from './config'

const dirs: string[] = []

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-cfg-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, contents)
  return path
}

function backupFiles(path: string): string[] {
  const prefix = `${basename(path)}.v0-to-v${CURRENT_CONFIG_SCHEMA_VERSION}.`
  return readdirSync(dirname(path)).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.bak'),
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('embeddings default to the local engine with the locked model/dim', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
  expect(cfg.processing.embeddings.engine).toBe('local')
  expect(cfg.processing.embeddings.options?.model).toBe('multilingual-e5-small')
  expect(cfg.processing.embeddings.options?.dim).toBe(384)
})

test('saving a migrated legacy config writes schema_version and creates a backup', () => {
  const path = tmpConfig('{"storage":{"encryption":{"enabled":false}}}')
  const cfg = loadConfigForEditing(path)

  saveConfig(cfg, path)

  const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  expect(saved.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
  expect((saved.storage as Record<string, unknown>).encryption).toBeUndefined()
  const backups = backupFiles(path)
  expect(backups).toHaveLength(1)
  const backup = JSON.parse(readFileSync(join(dirname(path), backups[0] ?? ''), 'utf8')) as {
    storage?: { encryption?: { enabled?: boolean } }
  }
  expect(backup.storage?.encryption?.enabled).toBe(false)
})

test('saving a current config does not create a backup', () => {
  const path = tmpConfig(`{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION}}`)
  const cfg = loadConfigForEditing(path)

  saveConfig(cfg, path)

  expect(backupFiles(path)).toHaveLength(0)
})

test('future and invalid config schema versions are rejected', () => {
  for (const version of [CURRENT_CONFIG_SCHEMA_VERSION + 1, '"x"', -1, 1.5] as const) {
    expect(() => loadConfig(tmpConfig(`{"schema_version":${version}}`))).toThrow(/schema_version/)
  }
})

test('unknown embedding engine falls back to local and locks model/dim', () => {
  const cfg = loadConfig(
    tmpConfig('{"processing":{"embeddings":{"engine":"bogus","options":{"model":"x","dim":99}}}}'),
  )
  expect(cfg.processing.embeddings.engine).toBe('local')
  expect(cfg.processing.embeddings.options?.model).toBe('multilingual-e5-small')
  expect(cfg.processing.embeddings.options?.dim).toBe(384)
})

test('embeddings engine can be disabled with noop', () => {
  const cfg = loadConfig(tmpConfig('{"processing":{"embeddings":{"engine":"noop"}}}'))
  expect(cfg.processing.embeddings.engine).toBe('noop')
})

test('lossy blob formats default to webp screenshots and webm audio', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.capture.screen.format).toBe('webp')
  expect(cfg.capture.audio.format).toBe('webm')
  expect(cfg.capture.audio.bitrate_kbps).toBe(24)
})

test('transcription defaults to parakeet on every OS', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.processing.transcription.engine).toBe('parakeet')
  expect(cfg.processing.transcription.options?.model).toBe('parakeet-tdt-0.6b-v3')
  // Parakeet is multilingual and runs at its converted precision, so the
  // whisper-only language/compute_type knobs are absent.
  expect(cfg.processing.transcription.options?.language).toBeUndefined()
  expect(cfg.processing.transcription.options?.compute_type).toBeUndefined()
})

test('v3 whisper config migrates back to parakeet with a backup', () => {
  const path = tmpConfig(
    '{"schema_version":3,"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-large-v3-turbo","language":"auto","compute_type":"int8","live":{"silence_ms":1234}}}}}',
  )
  const cfg = loadConfigForEditing(path)
  expect(cfg.processing.transcription.engine).toBe('parakeet')
  expect(cfg.processing.transcription.options?.model).toBe('parakeet-tdt-0.6b-v3')
  expect(cfg.processing.transcription.options?.compute_type).toBeUndefined()
  expect((cfg.processing.transcription.options?.live as { silence_ms?: number }).silence_ms).toBe(
    1234,
  )

  saveConfig(cfg, path)
  const backups = readdirSync(dirname(path)).filter(
    (name) =>
      name.startsWith(`${basename(path)}.v3-to-v${CURRENT_CONFIG_SCHEMA_VERSION}.`) &&
      name.endsWith('.bak'),
  )
  expect(backups).toHaveLength(1)
})

test('v0 legacy config chains migrations to parakeet and drops encryption', () => {
  const cfg = loadConfig(
    tmpConfig(
      '{"storage":{"encryption":{"enabled":false}},"processing":{"transcription":{"engine":"auto"}}}',
    ),
  )
  expect(cfg.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
  expect((cfg.storage as unknown as Record<string, unknown>).encryption).toBeUndefined()
  expect(cfg.processing.transcription.engine).toBe('parakeet')
})

test('a v4 config drops the sync and encryption blocks', () => {
  const cfg = loadConfig(
    tmpConfig(
      '{"schema_version":4,"sync":{"enabled":true},"storage":{"encryption":{"blobs":true}}}',
    ),
  )
  expect(cfg.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
  expect((cfg as unknown as Record<string, unknown>).sync).toBeUndefined()
  expect((cfg.storage as unknown as Record<string, unknown>).encryption).toBeUndefined()
})

test('v1 noop transcription survives the v2 migration', () => {
  const cfg = loadConfig(
    tmpConfig('{"schema_version":1,"processing":{"transcription":{"engine":"noop"}}}'),
  )
  expect(cfg.processing.transcription.engine).toBe('noop')
})

test('v2 config keeps an explicit parakeet engine and drops its language option', () => {
  const cfg = loadConfig(
    tmpConfig(
      '{"schema_version":2,"processing":{"transcription":{"engine":"parakeet","options":{"language":"fr"}}}}',
    ),
  )
  expect(cfg.processing.transcription.engine).toBe('parakeet')
  expect(cfg.processing.transcription.options?.model).toBe('parakeet-tdt-0.6b-v3')
  expect(cfg.processing.transcription.options?.language).toBeUndefined()
})

test('an explicit whisper engine is still honored at the current schema version', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-small","language":"fr"}}}}`,
    ),
  )
  expect(cfg.processing.transcription.engine).toBe('whisper')
  expect(cfg.processing.transcription.options?.model).toBe('whisper-small')
  expect(cfg.processing.transcription.options?.language).toBe('fr')
})

test('unknown whisper model and blank language fall back to defaults', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-bogus","language":"  "}}}}`,
    ),
  )
  expect(cfg.processing.transcription.options?.model).toBe('whisper-large-v3-turbo')
  expect(cfg.processing.transcription.options?.language).toBe('auto')
})

test('retired whisper -q5 models remap to their CTranslate2 base with compute_type', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-large-v3-turbo-q5","language":"fr"}}}}`,
    ),
  )
  expect(cfg.schema_version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
  expect(cfg.processing.transcription.options?.model).toBe('whisper-large-v3-turbo')
  expect(cfg.processing.transcription.options?.language).toBe('fr')
  expect(cfg.processing.transcription.options?.compute_type).toBe('int8')
})

test('retired large-v3-q5 remaps to large-v3', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-large-v3-q5"}}}}`,
    ),
  )
  expect(cfg.processing.transcription.options?.model).toBe('whisper-large-v3')
})

test('explicit compute_type survives when valid and falls back when unknown', () => {
  const ok = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-small","compute_type":"int8"}}}}`,
    ),
  )
  expect(ok.processing.transcription.options?.compute_type).toBe('int8')

  const bogus = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-small","compute_type":"int4_nonsense"}}}}`,
    ),
  )
  expect(bogus.processing.transcription.options?.compute_type).toBe('int8')
})

test('parakeet engine drops compute_type', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"parakeet","options":{"compute_type":"int8"}}}}`,
    ),
  )
  expect(cfg.processing.transcription.options?.compute_type).toBeUndefined()
})

test('whisper language is preserved and trimmed', () => {
  const cfg = loadConfig(
    tmpConfig(
      `{"schema_version":${CURRENT_CONFIG_SCHEMA_VERSION},"processing":{"transcription":{"engine":"whisper","options":{"model":"whisper-small","language":" fr "}}}}`,
    ),
  )
  expect(cfg.processing.transcription.options?.model).toBe('whisper-small')
  expect(cfg.processing.transcription.options?.language).toBe('fr')
})

test('invalid blob formats fall back to lossy defaults and clamp bitrate', () => {
  const cfg = loadConfig(
    tmpConfig(
      '{"capture":{"screen":{"format":"gif"},"audio":{"format":"mp3","bitrate_kbps":999}}}',
    ),
  )
  expect(cfg.capture.screen.format).toBe('webp')
  expect(cfg.capture.audio.format).toBe('webm')
  expect(cfg.capture.audio.bitrate_kbps).toBe(256)
})

test('editing a loaded config leaves the defaults untouched', () => {
  const edited = loadConfigForEditing(tmpConfig('{}'))
  edited.capture.audio.mic.enabled = false
  expect(loadConfigForEditing(tmpConfig('{}')).capture.audio.mic.enabled).toBe(true)
})
