// Unit tests for the period_activity building blocks (#86): active-duration
// estimation, session enrichment (excerpts, project context, domain), and the
// per-day aggregates. Values are pinned so the deterministic contract is loud
// when it changes.

import { expect, test } from 'bun:test'
import {
  buildDayAggregates,
  buildPeriodSessions,
  estimatedActiveMs,
  localDayKey,
  type PeriodSession,
} from './period'
import type { ChunkRow, SegmentRow } from './types'

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

function segment(over: Partial<SegmentRow> & Pick<SegmentRow, 'id' | 'chunk_id'>): SegmentRow {
  return {
    source: 'mic',
    start_at: T,
    end_at: T + 1_000,
    text: 'hello',
    engine: 'whisper:whisper-small',
    transcribe_ms: 10,
    ...over,
  }
}

const T = 1_700_000_000_000

// ---- estimatedActiveMs ----------------------------------------------------

test('estimatedActiveMs: empty input is zero', () => {
  expect(estimatedActiveMs([])).toBe(0)
})

test('estimatedActiveMs: single instantaneous screenshot gets the 5s floor', () => {
  expect(estimatedActiveMs([{ start: T, end: T }])).toBe(5_000)
})

test('estimatedActiveMs: gaps between captures are capped at 30s', () => {
  // 5s gap + 120s gap (capped to 30s) + last item floor 5s = 40s.
  const items = [
    { start: T, end: T },
    { start: T + 5_000, end: T + 5_000 },
    { start: T + 125_000, end: T + 125_000 },
  ]
  expect(estimatedActiveMs(items)).toBe(5_000 + 30_000 + 5_000)
})

test('estimatedActiveMs: long final audio chunk is capped at 30s', () => {
  expect(estimatedActiveMs([{ start: T, end: T + 90_000 }])).toBe(30_000)
})

test('estimatedActiveMs: unsorted input is sorted by start', () => {
  const items = [
    { start: T + 10_000, end: T + 10_000 },
    { start: T, end: T },
  ]
  expect(estimatedActiveMs(items)).toBe(10_000 + 5_000)
})

// ---- buildPeriodSessions --------------------------------------------------

test('sessions split on the 30s gap rule and report durations per session', () => {
  const rows = [
    chunk({
      id: 'a1',
      at: T,
      kind: 'screenshot',
      window_app: 'Code',
      window_title: 'x - hyprmnesia - Code',
      text: 'editor text',
    }),
    chunk({
      id: 'a2',
      at: T + 5_000,
      kind: 'screenshot',
      window_app: 'Code',
      window_title: 'x - hyprmnesia - Code',
      text: 'more text',
    }),
    // 60s gap → new session even with the same window key.
    chunk({
      id: 'b1',
      at: T + 65_000,
      kind: 'screenshot',
      window_app: 'Code',
      window_title: 'x - hyprmnesia - Code',
      text: 'later',
    }),
  ]
  const sessions = buildPeriodSessions(rows, new Map())
  expect(sessions).toHaveLength(2)
  expect(sessions[0]?.counts.chunks).toBe(2)
  expect(sessions[0]?.estimated_active_ms).toBe(5_000 + 5_000)
  expect(sessions[1]?.counts.chunks).toBe(1)
  expect(sessions[0]?.project?.repo).toBe('hyprmnesia')
})

test('sources stay separated between window groups and audio buckets', () => {
  const rows = [
    chunk({ id: 's1', at: T, kind: 'screenshot', window_app: 'Zoom', window_title: 'Call' }),
    chunk({
      id: 's2',
      at: T + 5_000,
      kind: 'screenshot',
      window_app: 'Zoom',
      window_title: 'Call',
    }),
    chunk({ id: 'm1', at: T + 1_000, kind: 'audio_mic', end_at: T + 6_000 }),
    chunk({ id: 'y1', at: T + 2_000, kind: 'audio_system', end_at: T + 7_000 }),
  ]
  const sessions = buildPeriodSessions(rows, new Map())
  expect(sessions).toHaveLength(1)
  expect(sessions[0]?.sources).toEqual(['screen', 'system', 'mic'])
  expect(sessions[0]?.counts.screen).toBe(2)
  expect(sessions[0]?.counts.mic).toBe(1)
  expect(sessions[0]?.counts.system).toBe(1)
})

test('excerpts pick the first non-empty OCR text and the longest transcripts, with ids', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Zoom',
      window_title: 'Call',
      text: '',
    }),
    chunk({
      id: 's2',
      at: T + 1_000,
      kind: 'screenshot',
      window_app: 'Zoom',
      window_title: 'Call',
      text: 'agenda on screen',
    }),
    chunk({ id: 'm1', at: T + 500, kind: 'audio_mic', end_at: T + 30_000 }),
  ]
  const segments = new Map([
    [
      'm1',
      [
        segment({ id: 'seg-short', chunk_id: 'm1', start_at: T + 2_000, text: 'ok' }),
        segment({
          id: 'seg-long',
          chunk_id: 'm1',
          start_at: T + 3_000,
          text: 'the much longer discussion about the roadmap',
        }),
        segment({ id: 'seg-mid', chunk_id: 'm1', start_at: T + 4_000, text: 'middle length text' }),
        segment({ id: 'seg-empty', chunk_id: 'm1', start_at: T + 5_000, text: '   ' }),
      ],
    ],
  ])
  const sessions = buildPeriodSessions(rows, segments)
  expect(sessions).toHaveLength(1)
  const excerpts = sessions[0]!.excerpts
  expect(excerpts).toHaveLength(3)
  expect(excerpts.map((e) => e.kind).sort()).toEqual(['ocr', 'transcript', 'transcript'])
  const ocr = excerpts.find((e) => e.kind === 'ocr')
  expect(ocr?.id).toBe('s2')
  expect(ocr?.chunk_id).toBe('s2')
  expect(ocr?.text).toBe('agenda on screen')
  const transcriptIds = excerpts.filter((e) => e.kind === 'transcript').map((e) => e.id)
  expect(transcriptIds).toEqual(expect.arrayContaining(['seg-long', 'seg-mid']))
  expect(transcriptIds).not.toContain('seg-empty')
})

test('chunks with no text produce no excerpts', () => {
  const rows = [chunk({ id: 'm1', at: T, kind: 'audio_mic', end_at: T + 5_000 })]
  const sessions = buildPeriodSessions(rows, new Map())
  expect(sessions[0]?.excerpts).toEqual([])
})

test('native URL produces a domain; project comes from the window title', () => {
  const rows = [
    chunk({
      id: 's1',
      at: T,
      kind: 'screenshot',
      window_app: 'Firefox',
      window_title: 'PR review',
      window_url: 'https://www.github.com/hyprmnesia/hyprmnesia/pull/1',
    }),
  ]
  const sessions = buildPeriodSessions(rows, new Map())
  expect(sessions[0]?.domain).toBe('github.com')
  expect(sessions[0]?.url).toContain('github.com')
  expect(sessions[0]?.project).toBeNull()
})

// ---- buildDayAggregates ---------------------------------------------------

function fakeSession(over: Partial<PeriodSession>): PeriodSession {
  return {
    id: 'activity:x',
    date: '2026-06-08',
    start_at: T,
    end_at: T + 60_000,
    timezone: 'UTC',
    local_start_at: '',
    utc_start_at: '',
    local_end_at: '',
    utc_end_at: '',
    duration_ms: 60_000,
    estimated_active_ms: 60_000,
    window: { app: null, title: null, url: null, pid: null },
    app: null,
    url: null,
    domain: null,
    project: null,
    sources: ['screen'],
    counts: { chunks: 1, screen: 1, mic: 0, system: 0, transcript_segments: 0 },
    excerpts: [],
    ...over,
  }
}

test('day aggregates sum sessions per app/project/domain/source', () => {
  const sessions = [
    fakeSession({
      app: 'Code',
      estimated_active_ms: 120_000,
      project: { repo: 'hyprmnesia', branch: null, ssh_host: null, source: 'window_title' },
    }),
    fakeSession({
      app: 'Code',
      estimated_active_ms: 60_000,
      project: { repo: 'hyprmnesia', branch: null, ssh_host: null, source: 'window_title' },
    }),
    fakeSession({
      app: 'Firefox',
      estimated_active_ms: 30_000,
      domain: 'github.com',
      sources: ['screen', 'system'],
    }),
  ]
  const day = buildDayAggregates('2026-06-08', sessions)
  expect(day.sessions).toBe(3)
  expect(day.estimated_active_ms).toBe(210_000)
  expect(day.by_app).toEqual([
    { key: 'Code', sessions: 2, estimated_active_ms: 180_000 },
    { key: 'Firefox', sessions: 1, estimated_active_ms: 30_000 },
  ])
  expect(day.by_project).toEqual([{ key: 'hyprmnesia', sessions: 2, estimated_active_ms: 180_000 }])
  expect(day.by_domain).toEqual([{ key: 'github.com', sessions: 1, estimated_active_ms: 30_000 }])
  expect(day.by_source).toEqual([
    { key: 'screen', sessions: 3, estimated_active_ms: 210_000 },
    { key: 'system', sessions: 1, estimated_active_ms: 30_000 },
  ])
})

test('localDayKey formats the local calendar day', () => {
  const d = new Date(2026, 5, 8, 14, 30)
  expect(localDayKey(d.getTime())).toBe('2026-06-08')
})
