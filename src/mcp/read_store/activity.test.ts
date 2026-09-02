// Tests for buildActivityGroups — the grouping algorithm that powers the
// `recent_activity` MCP tool. The algorithm has a lot of branches:
//   * window-key bucketing (URL > app+title > source fallback)
//   * 30-second gap to start a new group
//   * unwindowed audio attaches to an overlapping screen group, then falls
//     back to an `audio:<source>` bucket
//   * URL extraction from OCR text when no native URL is available
//   * progressive window-field merging across rows in the same group
//
// Bugs here corrupt the timeline users see in chat clients — silently — so
// the tests below assert each rule with the smallest fixture that triggers
// it, and pin the precise output shape (sources order, chunk_ids order,
// counts, url_source/url_confidence) so regressions are loud.

import { expect, test } from 'bun:test'
import { buildActivityGroups } from './activity'
import type { ChunkRow } from './types'

// ---- Fixture helpers ------------------------------------------------------

/** Minimal ChunkRow factory. All audio/window/OCR fields default to null. */
function chunk(over: Partial<ChunkRow> & Pick<ChunkRow, 'id' | 'at' | 'kind'>): ChunkRow {
  return {
    start_at: over.at,
    end_at: over.at,
    blob: '',
    bytes: 0,
    text: '',
    capture_ms: 0,
    window_app: null,
    window_title: null,
    window_url: null,
    window_pid: null,
    ocr_engine: null,
    audio_engine: null,
    audio_device: null,
    audio_sample_rate: null,
    audio_chunk_ms: null,
    audio_rms_db: null,
    audio_peak_db: null,
    ...over,
  }
}

// Anchor time so all relative `at` values stay readable.
const T = 1_700_000_000_000

// ---- Empty / single-row sanity -------------------------------------------

test('empty input → empty groups', () => {
  expect(buildActivityGroups([])).toEqual([])
})

test('single windowed screenshot → one group with one chunk', () => {
  const groups = buildActivityGroups([
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Chrome', window_title: 'Foo' }),
  ])
  expect(groups).toHaveLength(1)
  expect(groups[0]?.counts.chunks).toBe(1)
  expect(groups[0]?.sources).toEqual(['screen'])
  expect(groups[0]?.chunk_ids).toEqual(['s1'])
  expect(groups[0]?.window.app).toBe('Chrome')
  expect(groups[0]?.window.title).toBe('Foo')
})

// ---- Window-key bucketing -------------------------------------------------

test('same window URL collapses chunks into a single group, even with different titles', () => {
  // The URL takes precedence over app/title in windowKey, so a tab-title
  // change inside the same SPA stays in one activity.
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page A',
      window_url: 'https://example.com/app',
    }),
    chunk({
      id: 's2',
      at: T + 5_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page B (different title)',
      window_url: 'https://example.com/app',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.chunk_ids).toEqual(['s1', 's2'])
  expect(groups[0]?.url).toBe('https://example.com/app')
})

test('same app+title with no URL collapses into one group', () => {
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Code', window_title: 'foo.ts' }),
    chunk({
      id: 's2',
      at: T + 10_000,
      kind: 'screenshot',
      window_app: 'Code',
      window_title: 'foo.ts',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.chunk_ids).toEqual(['s1', 's2'])
})

test('different URLs land in different groups', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_url: 'https://a.com/',
    }),
    chunk({
      id: 's2',
      at: T + 1_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_url: 'https://b.com/',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(2)
  expect(groups.map((g) => g.url)).toEqual(['https://a.com/', 'https://b.com/'])
})

test('different app+title combinations land in different groups', () => {
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'A', window_title: 'X' }),
    chunk({ id: 's2', at: T + 1_000, kind: 'screenshot', window_app: 'A', window_title: 'Y' }),
    chunk({ id: 's3', at: T + 2_000, kind: 'screenshot', window_app: 'B', window_title: 'X' }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(3)
})

// ---- 30-second gap rule ---------------------------------------------------

test('two rows in the same window within 30s are merged', () => {
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Chrome', window_title: 'Page' }),
    chunk({
      id: 's2',
      at: T + 30_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
})

test('two rows in the same window > 30s apart split into two groups', () => {
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Chrome', window_title: 'Page' }),
    chunk({
      id: 's2',
      at: T + 30_001,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(2)
})

// ---- Window-field merging across the group --------------------------------

test('progressive window merging: nullish fields fill in from later rows in the same group', () => {
  // Same windowKey (window:Chrome|Page) on both rows so they bucket together;
  // row 1 has no pid, row 2 supplies one — the group inherits it. URL would
  // CHANGE the key (url:... vs window:...) so we don't fill it in via this
  // path; that's a different group.
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
      window_pid: null,
    }),
    chunk({
      id: 's2',
      at: T + 5_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
      window_pid: 4242,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.window.pid).toBe(4242)
})

test('a later row that introduces a URL splits into a new group (URL changes the windowKey)', () => {
  // This pins a subtle behavior: progressive URL-merging is impossible inside
  // a single group because the URL key always wins over app+title. Two rows
  // with "same Chrome window" but a new URL end up as two groups.
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Chrome', window_title: 'Page' }),
    chunk({
      id: 's2',
      at: T + 5_000,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
      window_url: 'https://later.example.com/path',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(2)
})

// ---- Source/chunk ordering inside a group ---------------------------------

test('chunks inside a group are sorted by time then by source order (screen < system < mic)', () => {
  // Same window, three chunks at identical `at` — sourceOrder breaks the tie.
  const rows = [
    chunk({
      id: 'mic-1',
      at: T,
      kind: 'audio_mic',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
    chunk({
      id: 'sys-1',
      at: T,
      kind: 'audio_system',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
    chunk({
      id: 'scr-1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  // sortedChunks order: screen(0) < system(1) < mic(2)
  expect(groups[0]?.chunk_ids).toEqual(['scr-1', 'sys-1', 'mic-1'])
  expect(groups[0]?.sources).toEqual(['screen', 'system', 'mic'])
})

test('chunk_ids_by_source separates ids per source', () => {
  const rows = [
    chunk({
      id: 'scr-1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
    chunk({
      id: 'mic-1',
      at: T + 1_000,
      kind: 'audio_mic',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.chunk_ids_by_source).toEqual({
    screen: ['scr-1'],
    mic: ['mic-1'],
    system: [],
  })
  expect(groups[0]?.counts).toMatchObject({ chunks: 2, screen: 1, mic: 1, system: 0 })
})

// ---- Unwindowed-audio attachment ------------------------------------------

test('unwindowed audio attaches to an overlapping screen group', () => {
  const rows = [
    chunk({
      id: 'scr-1',
      at: T,
      kind: 'screenshot',
      start_at: T,
      end_at: T + 10_000,
      window_app: 'Chrome',
      window_title: 'Page',
    }),
    // Audio at T+5s with no window info — falls within the screen group.
    chunk({
      id: 'mic-1',
      at: T + 5_000,
      kind: 'audio_mic',
      start_at: T + 5_000,
      end_at: T + 6_000,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.chunk_ids).toContain('mic-1')
  expect(groups[0]?.sources).toContain('mic')
})

test('unwindowed audio with no overlapping screen group creates its own audio:mic group', () => {
  const rows = [chunk({ id: 'mic-1', at: T, kind: 'audio_mic', start_at: T, end_at: T + 1_000 })]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.sources).toEqual(['mic'])
  expect(groups[0]?.window).toEqual({ app: null, title: null, url: null, pid: null })
})

test('two unwindowed mic chunks within 30s merge into one audio:mic group', () => {
  const rows = [
    chunk({ id: 'mic-1', at: T, kind: 'audio_mic', start_at: T, end_at: T + 5_000 }),
    chunk({
      id: 'mic-2',
      at: T + 20_000,
      kind: 'audio_mic',
      start_at: T + 20_000,
      end_at: T + 25_000,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.chunk_ids).toEqual(['mic-1', 'mic-2'])
})

test('two unwindowed mic chunks > 30s apart split into two audio:mic groups', () => {
  const rows = [
    chunk({ id: 'mic-1', at: T, kind: 'audio_mic', start_at: T, end_at: T + 5_000 }),
    chunk({
      id: 'mic-2',
      at: T + 5_000 + 30_001,
      kind: 'audio_mic',
      start_at: T + 5_000 + 30_001,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(2)
})

test('mic and system unwindowed audio stay separate (different audio:* keys)', () => {
  const rows = [
    chunk({ id: 'mic-1', at: T, kind: 'audio_mic', start_at: T, end_at: T + 1_000 }),
    chunk({
      id: 'sys-1',
      at: T + 500,
      kind: 'audio_system',
      start_at: T + 500,
      end_at: T + 1_500,
    }),
  ]
  const groups = buildActivityGroups(rows)
  // No screen group to attach to, and mic vs system have different keys.
  expect(groups).toHaveLength(2)
  const sources = groups.map((g) => g.sources.join(','))
  expect(sources).toContain('mic')
  expect(sources).toContain('system')
})

// ---- URL extraction from OCR text -----------------------------------------

test('url_source=native when window.url is present, even with a URL in OCR text', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_url: 'https://native.example.com/x',
      text: 'visible URL on page: https://other.com/abc',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.url).toBe('https://native.example.com/x')
  expect(groups[0]?.url_source).toBe('native')
  expect(groups[0]?.url_confidence).toBe('high')
  expect(groups[0]?.url_candidate).toBeNull()
})

test('url_source=ocr_candidate when no native URL but OCR text has one', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Terminal',
      window_title: 'bash',
      text: 'check out https://news.ycombinator.com/item?id=42 for the discussion',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.url).toBeNull()
  expect(groups[0]?.url_source).toBe('ocr_candidate')
  expect(groups[0]?.url_confidence).toBe('low')
  expect(groups[0]?.url_candidate).toBe('https://news.ycombinator.com/item?id=42')
})

test('OCR URL extraction strips trailing punctuation', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Terminal',
      window_title: 'bash',
      text: 'see https://foo.example.com/bar.',
    }),
  ]
  const groups = buildActivityGroups(rows)
  // Trailing `.` is stripped per `extractUrlCandidate`.
  expect(groups[0]?.url_candidate).toBe('https://foo.example.com/bar')
})

test('OCR URL extraction picks up bare domain.tld/path form', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Terminal',
      window_title: 'bash',
      text: 'docs at example.com/docs/intro for more',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.url_candidate).toBe('example.com/docs/intro')
  expect(groups[0]?.url_source).toBe('ocr_candidate')
})

test('OCR text with no recognizable URL leaves url_source=none', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Notes',
      window_title: 'Untitled',
      text: 'a few lines of plain text with no link in sight',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.url).toBeNull()
  expect(groups[0]?.url_candidate).toBeNull()
  expect(groups[0]?.url_source).toBe('none')
  expect(groups[0]?.url_confidence).toBe('none')
})

// ---- Audio summary diagnostics --------------------------------------------

test('audio summary aggregates rms/peak ranges and unique states per source', () => {
  const rows = [
    chunk({
      id: 'scr-1',
      at: T,
      kind: 'screenshot',
      window_app: 'Chrome',
      window_title: 'Page',
    }),
    chunk({
      id: 'mic-1',
      at: T + 1_000,
      kind: 'audio_mic',
      end_at: T + 2_000,
      bytes: 100,
      text: 'hello world',
      window_app: 'Chrome',
      window_title: 'Page',
      audio_engine: 'parakeet',
      audio_rms_db: -30,
      audio_peak_db: -10,
    }),
    chunk({
      id: 'mic-2',
      at: T + 3_000,
      kind: 'audio_mic',
      end_at: T + 4_000,
      bytes: 100,
      text: 'second segment',
      window_app: 'Chrome',
      window_title: 'Page',
      audio_engine: 'parakeet',
      audio_rms_db: -50,
      audio_peak_db: -25,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups).toHaveLength(1)
  const mic = groups[0]?.audio.mic
  expect(mic).toBeDefined()
  expect(mic?.rms_db_min).toBe(-50)
  expect(mic?.rms_db_max).toBe(-30)
  expect(mic?.peak_db_max).toBe(-10)
  // Both chunks have text → both 'transcribed'. Set dedups.
  expect(mic?.states).toEqual(['transcribed'])
  // No system audio at all.
  expect(groups[0]?.audio.system).toBeUndefined()
})

// ---- Group-level ordering -------------------------------------------------

test('returned groups are sorted by start_at ascending', () => {
  const rows = [
    chunk({
      id: 'b',
      at: T + 100_000,
      kind: 'screenshot',
      window_app: 'A',
      window_title: 'Late',
    }),
    chunk({ id: 'a', at: T, kind: 'screenshot', window_app: 'A', window_title: 'Early' }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups.map((g) => g.window.title)).toEqual(['Early', 'Late'])
})

test('duration_ms is end_at - start_at, never negative', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      start_at: T,
      end_at: T + 12_345,
      window_app: 'Chrome',
      window_title: 'X',
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.duration_ms).toBe(12_345)
})

test('text_preview is the concatenation of group OCR text, clamped to 600 chars', () => {
  const long = 'lorem ipsum '.repeat(80) // > 600 chars
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Browser',
      window_title: 'Article',
      text: long,
    }),
  ]
  const groups = buildActivityGroups(rows)
  expect(groups[0]?.text_preview.length).toBeLessThanOrEqual(600)
  expect(groups[0]?.text_preview.endsWith('...')).toBe(true)
})
