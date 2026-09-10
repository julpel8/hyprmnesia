// Tests for the pure formatting layer used by every read-store output
// (timeline items, recall payloads, activity groups). Most functions are
// trivial (chunkSource, mimeForKind, excerpt, numericRange) but
// `audioState` is a real state machine — its branches are how the UI
// distinguishes "still recording" from "transcribed" from "too quiet to
// transcribe" — so we drive it through every transition.
//
// `audioState` is private; we exercise it through `toTimelineItem` which is
// where it actually runs in production.

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chunkSource,
  excerpt,
  iso,
  kindForSource,
  LOCAL_TIMEZONE,
  localIso,
  mimeForKind,
  numericRange,
  textPresent,
  toSegment,
  toTimelineItem,
  windowFromRow,
} from './format'
import type { ChunkRow, SegmentRow } from './types'

// ---- iso / localIso -------------------------------------------------------

test('iso: number → ISO 8601 UTC string', () => {
  expect(iso(0)).toBe('1970-01-01T00:00:00.000Z')
  expect(iso(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString())
})

test('iso: null/undefined → null', () => {
  expect(iso(null)).toBeNull()
  expect(iso(undefined)).toBeNull()
})

test('localIso: round-trips back to the same instant via Date.parse', () => {
  // The exact local format depends on the runner's timezone; we don't
  // hard-code it. What matters is that the produced string parses back to
  // the original epoch ms. That covers the offset sign + zero-padding.
  const at = 1_700_000_000_000
  const formatted = localIso(at)!
  expect(typeof formatted).toBe('string')
  expect(Date.parse(formatted)).toBe(at)
  // Must end with a UTC offset of the form ±HH:MM (length 6).
  expect(/[+-]\d{2}:\d{2}$/.test(formatted)).toBe(true)
})

test('localIso: null/undefined → null', () => {
  expect(localIso(null)).toBeNull()
  expect(localIso(undefined)).toBeNull()
})

test('LOCAL_TIMEZONE is a non-empty string identifier', () => {
  expect(typeof LOCAL_TIMEZONE).toBe('string')
  expect(LOCAL_TIMEZONE.length).toBeGreaterThan(0)
})

// ---- chunkSource / kindForSource round-trip -------------------------------

test('chunkSource maps each kind to its source label', () => {
  expect(chunkSource('screenshot')).toBe('screen')
  expect(chunkSource('audio_mic')).toBe('mic')
  expect(chunkSource('audio_system')).toBe('system')
})

test('kindForSource: round-trips with chunkSource', () => {
  expect(kindForSource('screen')).toBe('screenshot')
  expect(kindForSource('mic')).toBe('audio_mic')
  expect(kindForSource('system')).toBe('audio_system')
})

test('kindForSource: undefined or unknown returns undefined', () => {
  expect(kindForSource(undefined)).toBeUndefined()
})

// ---- windowFromRow --------------------------------------------------------

test('windowFromRow lifts the four window_* columns into the canonical shape', () => {
  expect(
    windowFromRow({
      window_app: 'Chrome',
      window_title: 'Page',
      window_url: 'https://x',
      window_pid: 42,
    }),
  ).toEqual({ app: 'Chrome', title: 'Page', url: 'https://x', pid: 42 })
})

test('windowFromRow preserves nulls', () => {
  expect(
    windowFromRow({
      window_app: null,
      window_title: null,
      window_url: null,
      window_pid: null,
    }),
  ).toEqual({ app: null, title: null, url: null, pid: null })
})

// ---- excerpt --------------------------------------------------------------

test('excerpt: collapses runs of whitespace into single spaces and trims', () => {
  expect(excerpt('  hello\n\nworld  \t  ')).toBe('hello world')
})

test('excerpt: null/undefined treated as empty', () => {
  expect(excerpt(null)).toBe('')
  expect(excerpt(undefined)).toBe('')
})

test('excerpt: under the cap returns the normalized string', () => {
  expect(excerpt('a b c', 280)).toBe('a b c')
})

test('excerpt: over the cap is sliced with a trailing ellipsis', () => {
  const long = 'x'.repeat(500)
  const out = excerpt(long, 100)
  expect(out.length).toBe(100)
  expect(out.endsWith('...')).toBe(true)
})

test('excerpt: trims trailing space before appending the ellipsis', () => {
  // After whitespace-normalization "hello world" is 11 chars. With max=9,
  // slice(0, max-3) = slice(0, 6) = "hello " — the slice ends on a space.
  // trimEnd should drop that space so we don't render "hello ...".
  const out = excerpt('hello world', 9)
  expect(out).toBe('hello...')
})

// ---- textPresent ----------------------------------------------------------

test('textPresent: null / undefined / empty / whitespace-only → false', () => {
  expect(textPresent(null)).toBe(false)
  expect(textPresent(undefined)).toBe(false)
  expect(textPresent('')).toBe(false)
  expect(textPresent('  \n\t  ')).toBe(false)
})

test('textPresent: any non-whitespace character → true', () => {
  expect(textPresent('x')).toBe(true)
  expect(textPresent('  hello  ')).toBe(true)
})

// ---- numericRange ---------------------------------------------------------

test('numericRange: empty array → {min: null, max: null}', () => {
  expect(numericRange([])).toEqual({ min: null, max: null })
})

test('numericRange: all-null array → {min: null, max: null}', () => {
  expect(numericRange([null, undefined, null])).toEqual({ min: null, max: null })
})

test('numericRange: mixed null + numbers → min/max of the numbers', () => {
  expect(numericRange([-30, null, -50, -10, undefined])).toEqual({ min: -50, max: -10 })
})

test('numericRange: single value → min === max', () => {
  expect(numericRange([7])).toEqual({ min: 7, max: 7 })
})

// ---- mimeForKind ----------------------------------------------------------

test('mimeForKind: screenshot picks png by default, jpeg for .jpg/.jpeg, and webp for .webp', () => {
  expect(mimeForKind('screenshot', '/blobs/a.png')).toBe('image/png')
  expect(mimeForKind('screenshot', '/blobs/a.jpg')).toBe('image/jpeg')
  expect(mimeForKind('screenshot', '/blobs/a.jpeg')).toBe('image/jpeg')
  expect(mimeForKind('screenshot', '/blobs/a.webp')).toBe('image/webp')
  // Case-insensitive
  expect(mimeForKind('screenshot', '/blobs/A.JPG')).toBe('image/jpeg')
  expect(mimeForKind('screenshot', '/blobs/A.JPEG')).toBe('image/jpeg')
  expect(mimeForKind('screenshot', '/blobs/A.WEBP')).toBe('image/webp')
})

test('mimeForKind: audio kinds pick wav by default and webm/opus for .webm', () => {
  expect(mimeForKind('audio_mic', '/blobs/x.wav')).toBe('audio/wav')
  expect(mimeForKind('audio_system', '/blobs/x.wav')).toBe('audio/wav')
  expect(mimeForKind('audio_mic', '/blobs/x.webm')).toBe('audio/webm; codecs=opus')
  expect(mimeForKind('audio_system', '/blobs/X.WEBM')).toBe('audio/webm; codecs=opus')
  // Unknown audio extensions fall back to wav for legacy compatibility.
  expect(mimeForKind('audio_mic', '/blobs/x.mp3')).toBe('audio/wav')
})

// ---- toSegment ------------------------------------------------------------

test('toSegment lifts a SegmentRow into the API shape with timestamps populated', () => {
  const row: SegmentRow = {
    id: 'seg-1',
    chunk_id: 'chunk-1',
    source: 'mic',
    start_at: 1_700_000_000_000,
    end_at: 1_700_000_001_000,
    text: 'hello world',
    engine: 'parakeet',
    transcribe_ms: 42,
  }
  const seg = toSegment(row)
  expect(seg.id).toBe('seg-1')
  expect(seg.chunk_id).toBe('chunk-1')
  expect(seg.source).toBe('mic')
  expect(seg.text).toBe('hello world')
  expect(seg.engine).toBe('parakeet')
  expect(seg.transcribe_ms).toBe(42)
  expect(seg.utc_start_at).toBe(new Date(row.start_at).toISOString())
  expect(seg.utc_end_at).toBe(new Date(row.end_at).toISOString())
  expect(seg.timezone).toBe(LOCAL_TIMEZONE)
})

// ---- toTimelineItem / audioState ------------------------------------------
//
// We exercise the private `audioState` state machine through toTimelineItem
// since that's the production entry point. Each `audioState` branch gets a
// dedicated test below.

function audioRow(over: Partial<ChunkRow> & Pick<ChunkRow, 'id' | 'at' | 'kind'>): ChunkRow {
  return {
    start_at: over.at,
    end_at: over.at + 1_000,
    blob: '/dev/null',
    bytes: 1,
    text: '',
    capture_ms: 0,
    window_app: null,
    window_title: null,
    window_url: null,
    window_pid: null,
    ocr_engine: null,
    audio_engine: 'parakeet',
    audio_device: null,
    audio_sample_rate: 16_000,
    audio_chunk_ms: null,
    audio_rms_db: null,
    audio_peak_db: null,
    ...over,
  }
}

test('toTimelineItem: screenshots have no `audio` field', () => {
  const item = toTimelineItem(
    audioRow({ id: 's1', at: 1_000, kind: 'screenshot', audio_engine: null }),
  )
  expect(item.audio).toBeUndefined()
  expect(item.source).toBe('screen')
})

test('audioState: segment_count > 0 → transcribed', () => {
  const item = toTimelineItem(
    audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic' }),
    /* segmentCount */ 3,
  )
  expect(item.audio?.state).toBe('transcribed')
  expect(item.audio?.segment_count).toBe(3)
})

test('audioState: text present → transcribed (even with zero segments)', () => {
  const item = toTimelineItem(
    audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic', text: 'hello' }),
    0,
  )
  expect(item.audio?.state).toBe('transcribed')
})

test('audioState: still open (end_at = null) → recording', () => {
  const item = toTimelineItem(audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic', end_at: null }), 0)
  expect(item.audio?.state).toBe('recording')
})

test('audioState: zero bytes → recording (even with end_at set)', () => {
  const item = toTimelineItem(audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic', bytes: 0 }), 0)
  expect(item.audio?.state).toBe('recording')
})

test('audioState: audio_engine=pending and ended < 120s ago → pending', () => {
  // End within the freshness window so audioState picks 'pending'.
  const now = Date.now()
  const item = toTimelineItem(
    audioRow({
      id: 'm1',
      at: now - 5_000,
      kind: 'audio_mic',
      end_at: now - 1_000,
      audio_engine: 'pending',
    }),
    0,
  )
  expect(item.audio?.state).toBe('pending')
  expect(item.audio?.engine).toBe('pending')
})

test('audioState: pending but ended > 120s ago → captured_no_transcript', () => {
  const now = Date.now()
  const item = toTimelineItem(
    audioRow({
      id: 'm1',
      at: now - 300_000,
      kind: 'audio_mic',
      end_at: now - 200_000,
      audio_engine: 'pending',
    }),
    0,
  )
  // Past the 120s freshness window — drops out of `pending`.
  expect(item.audio?.state).toBe('captured_no_transcript')
})

test('audioState: very low peak_db (<= -75) → quiet_no_transcript', () => {
  const item = toTimelineItem(
    audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic', audio_peak_db: -80 }),
    0,
  )
  expect(item.audio?.state).toBe('quiet_no_transcript')
})

test('audioState: very low rms_db (<= -85) alone → quiet_no_transcript', () => {
  const item = toTimelineItem(
    audioRow({
      id: 'm1',
      at: 1_000,
      kind: 'audio_mic',
      audio_peak_db: -30, // not low
      audio_rms_db: -90, // low enough
    }),
    0,
  )
  expect(item.audio?.state).toBe('quiet_no_transcript')
})

test('audioState: average levels with no transcript → captured_no_transcript', () => {
  const item = toTimelineItem(
    audioRow({
      id: 'm1',
      at: 1_000,
      kind: 'audio_mic',
      audio_peak_db: -20,
      audio_rms_db: -40,
    }),
    0,
  )
  expect(item.audio?.state).toBe('captured_no_transcript')
})

// ---- toTimelineItem: assembly --------------------------------------------

test('toTimelineItem: duration_ms is end - start, clamped to ≥ 0', () => {
  const item = toTimelineItem(
    audioRow({
      id: 'm1',
      at: 1_000,
      kind: 'audio_mic',
      start_at: 1_000,
      end_at: 6_000,
    }),
  )
  expect(item.duration_ms).toBe(5_000)
})

test('toTimelineItem: end_at=null → duration_ms=null', () => {
  const item = toTimelineItem(audioRow({ id: 'm1', at: 1_000, kind: 'audio_mic', end_at: null }))
  expect(item.duration_ms).toBeNull()
})

test('toTimelineItem: bytes > 0 with a real on-disk file → has_blob=true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-format-'))
  const blob = join(dir, 'fake.png')
  writeFileSync(blob, 'x') // any bytes
  try {
    const item = toTimelineItem(
      audioRow({ id: 's1', at: 1_000, kind: 'screenshot', blob, bytes: 1 }),
    )
    expect(item.has_blob).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('toTimelineItem: bytes > 0 but blob path does not exist → has_blob=false', () => {
  const item = toTimelineItem(
    audioRow({
      id: 's1',
      at: 1_000,
      kind: 'screenshot',
      blob: '/definitely/does/not/exist.png',
      bytes: 10,
    }),
  )
  expect(item.has_blob).toBe(false)
})

test('toTimelineItem: bytes=0 → has_blob=false even if file would exist', () => {
  const item = toTimelineItem(
    audioRow({ id: 's1', at: 1_000, kind: 'screenshot', bytes: 0, blob: '/etc/hosts' }),
  )
  expect(item.has_blob).toBe(false)
})

test('toTimelineItem: long OCR text is excerpted, text_len reflects original length', () => {
  const long = 'lorem '.repeat(200)
  const item = toTimelineItem(
    audioRow({
      id: 's1',
      at: 1_000,
      kind: 'screenshot',
      text: long,
    }),
  )
  // Default excerpt cap is 280.
  expect(item.text.length).toBeLessThanOrEqual(280)
  // text_len is the *raw* length, not the excerpted one.
  expect(item.text_len).toBe(long.length)
})

test('toTimelineItem: window fields lift through from the row', () => {
  const item = toTimelineItem(
    audioRow({
      id: 's1',
      at: 1_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
      window_url: 'https://x',
      window_pid: 1234,
    }),
  )
  expect(item.window).toEqual({
    app: 'Chrome',
    title: 'Page',
    url: 'https://x',
    pid: 1234,
  })
})
