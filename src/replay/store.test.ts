import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadStoreError } from '../mcp/read_store'
import { openChunkStore } from '../store/db'
import { ReplayStore } from './store'

const dirs: string[] = []
const T = Date.UTC(2025, 0, 1, 12, 0, 0)

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-replay-'))
  dirs.push(dir)
  const blobDir = join(dir, 'blobs')
  mkdirSync(blobDir)
  const dbPath = join(dir, 'index.db')
  const store = openChunkStore(dbPath)
  // `chunks.blob` holds a path relative to the machine's own directory, which
  // here is the temp dir the database sits in.
  const blob = (name: string, data = name): string => {
    writeFileSync(join(blobDir, name), data)
    return join('blobs', name)
  }
  return { dir, dbPath, store, blob }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (attempt === 9) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
})

test('bounds() returns null endpoints for an empty index', () => {
  const { dbPath, store } = freshStore()
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    const bounds = replay.bounds()
    expect(bounds.from).toBeNull()
    expect(bounds.to).toBeNull()
    expect(bounds.local_from).toBeNull()
    expect(bounds.utc_from).toBeNull()
    expect(bounds.local_to).toBeNull()
    expect(bounds.utc_to).toBeNull()
    expect(typeof bounds.timezone).toBe('string')
  } finally {
    replay.close()
  }
})

test('bounds() spans chunk starts through end_at', () => {
  const { dbPath, store, blob } = freshStore()
  store.insert({
    id: 'screen',
    kind: 'screenshot',
    at: T + 2_000,
    blob: blob('screen.png'),
    bytes: 10,
    text: 'screen',
    capture_ms: 1,
  })
  store.insert({
    id: 'mic',
    kind: 'audio_mic',
    at: T + 1_000,
    start_at: T + 900,
    end_at: T + 4_000,
    blob: blob('mic.wav'),
    bytes: 20,
    text: '',
    capture_ms: 1,
    audio: { engine: 'parakeet', device: 'mic', sample_rate: 16_000, chunk_ms: 3_100 },
  })
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    const bounds = replay.bounds()
    expect(bounds.from).toBe(T + 900)
    expect(bounds.to).toBe(T + 4_000)
    expect(Date.parse(bounds.utc_from!)).toBe(T + 900)
    expect(Date.parse(bounds.utc_to!)).toBe(T + 4_000)
  } finally {
    replay.close()
  }
})

test('load() returns an empty manifest with stable timestamp fields', () => {
  const { dbPath, store } = freshStore()
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    const { manifest, blobs } = replay.load(T, T + 5_000)
    expect(manifest.from).toBe(T)
    expect(manifest.to).toBe(T + 5_000)
    expect(manifest.duration_ms).toBe(5_000)
    expect(Date.parse(manifest.utc_from)).toBe(T)
    expect(Date.parse(manifest.utc_to)).toBe(T + 5_000)
    expect(manifest.screenshots).toEqual([])
    expect(manifest.audio.mic).toEqual([])
    expect(manifest.audio.system).toEqual([])
    expect(manifest.segments).toEqual([])
    expect(blobs.size).toBe(0)
  } finally {
    replay.close()
  }
})

test('load() groups replay rows, clips offsets, and filters out-of-window segments', () => {
  const { dbPath, store, blob } = freshStore()
  const from = T + 1_000
  const to = T + 6_000
  const missingBlob = 'missing.wav'

  store.insert({
    id: 'screen-prev',
    kind: 'screenshot',
    at: T,
    blob: blob('screen-prev.png'),
    bytes: 11,
    text: 'previous screen',
    capture_ms: 2,
    window: { app: 'Chrome', title: 'Before', url: 'https://example.test', pid: 1 },
  })
  store.insert({
    id: 'screen-mid',
    kind: 'screenshot',
    at: T + 2_000,
    blob: blob('screen-mid.webp'),
    bytes: 12,
    text: 'middle screen',
    capture_ms: 2,
  })
  store.insert({
    id: 'screen-after',
    kind: 'screenshot',
    at: T + 7_000,
    blob: blob('screen-after.png'),
    bytes: 13,
    text: 'after screen',
    capture_ms: 2,
  })
  store.insert({
    id: 'mic-overlap',
    kind: 'audio_mic',
    at: T + 500,
    start_at: T + 500,
    end_at: T + 2_500,
    blob: blob('mic.webm'),
    bytes: 20,
    text: '',
    capture_ms: 3,
    audio: {
      engine: 'parakeet',
      device: 'mic-1',
      sample_rate: 16_000,
      chunk_ms: 2_000,
      rms_db: -25,
      peak_db: -6,
    },
  })
  store.insert({
    id: 'sys-mid',
    kind: 'audio_system',
    at: T + 3_000,
    start_at: T + 3_000,
    end_at: T + 5_000,
    blob: missingBlob,
    bytes: 30,
    text: '',
    capture_ms: 3,
    audio: {
      engine: 'parakeet',
      device: 'system-1',
      sample_rate: 16_000,
      chunk_ms: 2_000,
      rms_db: -35,
      peak_db: -12,
    },
  })
  store.insert({
    id: 'mic-before',
    kind: 'audio_mic',
    at: T - 1_000,
    start_at: T - 1_000,
    end_at: T + 900,
    blob: blob('mic-before.wav'),
    bytes: 10,
    text: '',
    capture_ms: 1,
    audio: { engine: 'parakeet', device: 'mic', sample_rate: 16_000, chunk_ms: 1_900 },
  })
  store.insert({
    id: 'sys-after',
    kind: 'audio_system',
    at: T + 6_500,
    start_at: T + 6_500,
    end_at: T + 7_500,
    blob: blob('sys-after.wav'),
    bytes: 10,
    text: '',
    capture_ms: 1,
    audio: { engine: 'parakeet', device: 'system', sample_rate: 16_000, chunk_ms: 1_000 },
  })

  store.insertTranscriptSegment({
    id: 'seg-span',
    chunk_id: 'mic-overlap',
    source: 'mic',
    start_at: T + 700,
    end_at: T + 1_200,
    text: 'spans the start',
    engine: 'parakeet',
    transcribe_ms: 7,
  })
  store.insertTranscriptSegment({
    id: 'seg-mid',
    chunk_id: 'sys-mid',
    source: 'system',
    start_at: T + 4_000,
    end_at: T + 4_500,
    text: 'inside window',
    engine: 'parakeet',
    transcribe_ms: 8,
  })
  store.insertTranscriptSegment({
    id: 'seg-before',
    chunk_id: 'mic-overlap',
    source: 'mic',
    start_at: T + 100,
    end_at: T + 900,
    text: 'before window',
    engine: 'parakeet',
    transcribe_ms: 9,
  })
  store.insertTranscriptSegment({
    id: 'seg-after',
    chunk_id: 'sys-mid',
    source: 'system',
    start_at: T + 6_100,
    end_at: T + 6_500,
    text: 'after window',
    engine: 'parakeet',
    transcribe_ms: 10,
  })
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    const { manifest, blobs } = replay.load(from, to)

    expect(manifest.screenshots.map((chunk) => chunk.id)).toEqual(['screen-prev', 'screen-mid'])
    expect(manifest.audio.mic.map((chunk) => chunk.id)).toEqual(['mic-overlap'])
    expect(manifest.audio.system.map((chunk) => chunk.id)).toEqual(['sys-mid'])
    expect(manifest.segments.map((segment) => segment.id)).toEqual(['seg-span', 'seg-mid'])

    const previous = manifest.screenshots[0]!
    expect(previous.offset_start_ms).toBe(0)
    expect(previous.blob_start_offset_ms).toBe(1_000)
    expect(previous.offset_end_ms).toBeNull()
    expect(previous.has_blob).toBe(true)
    expect(previous.mime_type).toBe('image/png')
    expect(previous.window.app).toBe('Chrome')

    const screenshot = manifest.screenshots[1]!
    expect(screenshot.offset_start_ms).toBe(1_000)
    expect(screenshot.mime_type).toBe('image/webp')

    const mic = manifest.audio.mic[0]!
    expect(mic.offset_start_ms).toBe(0)
    expect(mic.offset_end_ms).toBe(1_500)
    expect(mic.blob_start_offset_ms).toBe(500)
    expect(mic.duration_ms).toBe(2_000)
    expect(mic.mime_type).toBe('audio/webm; codecs=opus')
    expect(mic.has_blob).toBe(true)
    expect(mic.audio).toEqual({
      rms_db: -25,
      peak_db: -6,
      engine: 'parakeet',
      device: 'mic-1',
    })

    const system = manifest.audio.system[0]!
    expect(system.offset_start_ms).toBe(2_000)
    expect(system.offset_end_ms).toBe(4_000)
    expect(system.has_blob).toBe(false)
    expect(system.bytes).toBe(30)

    expect(manifest.segments[0]).toMatchObject({
      id: 'seg-span',
      source: 'mic',
      offset_start_ms: 0,
      offset_end_ms: 200,
      text: 'spans the start',
      transcribe_ms: 7,
    })
    expect(manifest.segments[1]).toMatchObject({
      id: 'seg-mid',
      source: 'system',
      offset_start_ms: 3_000,
      offset_end_ms: 3_500,
      text: 'inside window',
      transcribe_ms: 8,
    })

    expect(blobs.has('screen-prev')).toBe(true)
    expect(blobs.has('screen-mid')).toBe(true)
    expect(blobs.has('mic-overlap')).toBe(true)
    expect(blobs.has('sys-mid')).toBe(false)
  } finally {
    replay.close()
  }
})

test('load() propagates timestamp validation errors', () => {
  const { dbPath, store } = freshStore()
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    expect(() => replay.load('not-a-date', T)).toThrow(ReadStoreError)
    expect(() => replay.load(T + 1_000, T)).toThrow(ReadStoreError)
    expect(() => replay.load(undefined, T)).toThrow(ReadStoreError)
  } finally {
    replay.close()
  }
})

test('load() ignores a preceding screenshot older than the gap allowance', () => {
  const { dbPath, store, blob } = freshStore()
  // Yesterday's capture, then a range covering a session that recorded nothing:
  // the range must come back empty instead of replaying the stale frame.
  store.insert({
    id: 'screen-yesterday',
    kind: 'screenshot',
    at: T - 12 * 3_600_000,
    blob: blob('screen-yesterday.png'),
    bytes: 11,
    text: 'yesterday',
    capture_ms: 2,
  })
  store.close()

  const replay = new ReplayStore(dbPath)
  try {
    expect(replay.load(T, T + 900_000).manifest.screenshots).toHaveLength(0)
    // A frame just before the range still opens it.
    expect(
      replay.load(T - 12 * 3_600_000 + 5_000, T - 12 * 3_600_000 + 300_000).manifest.screenshots,
    ).toHaveLength(1)
  } finally {
    replay.close()
  }
})
