import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from '../../store/db'
import { HyprmnesiaReadStore, ReadStoreError, RRF_K0, rrfFuse } from './index'
import type { SearchResult } from './types'

// ---- Pure unit tests for the Reciprocal Rank Fusion arithmetic ------------
//
// rrfFuse() is the bit of searchHybrid that combines BM25 + vector rankings
// without a DB round-trip. Tested directly so we cover the cases the
// sqlite-vec integration test below can't always reach (CI runners without
// the native vec0 extension).

function fakeResult(id: string, time: number, type: 'chunk' | 'transcript_segment'): SearchResult {
  return {
    id,
    type,
    source: type === 'chunk' ? 'screen' : 'mic',
    time,
    timezone: 'UTC',
    local_time: new Date(time).toISOString(),
    utc_time: new Date(time).toISOString(),
    iso_time: new Date(time).toISOString(),
    snippet: `result-${id}`,
    // Inputs carry raw BM25 / vector distance scores; rrfFuse overwrites them.
    score: 999,
    chunk_id: type === 'chunk' ? id : `chunk-${id}`,
    window: { app: null, title: null, url: null, pid: null },
  }
}

test('rrfFuse: pure FTS path — vec empty, FTS-ordered output with RRF scores', () => {
  const fts = [fakeResult('a', 100, 'chunk'), fakeResult('b', 200, 'chunk')]
  const fused = rrfFuse(fts, [], 10, 0)
  expect(fused.map((r) => r.id)).toEqual(['a', 'b'])
  // Rank 0 → 1/(60+1), rank 1 → 1/(60+2).
  expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K0 + 1), 12)
  expect(fused[1]?.score).toBeCloseTo(1 / (RRF_K0 + 2), 12)
  expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0)
})

test('rrfFuse: pure vec path — FTS empty, vec-ordered output with RRF scores', () => {
  const vec = [fakeResult('x', 100, 'chunk'), fakeResult('y', 200, 'chunk')]
  const fused = rrfFuse([], vec, 10, 0)
  expect(fused.map((r) => r.id)).toEqual(['x', 'y'])
  expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K0 + 1), 12)
  expect(fused[1]?.score).toBeCloseTo(1 / (RRF_K0 + 2), 12)
})

test('rrfFuse: overlapping result — dedup and sum 1/(k+rank_fts) + 1/(k+rank_vec)', () => {
  const shared = fakeResult('shared', 1000, 'chunk')
  const ftsOnly = fakeResult('fts-only', 500, 'chunk')
  const vecOnly = fakeResult('vec-only', 600, 'chunk')
  // shared appears at rank 1 in FTS (index 1) and rank 0 in vec.
  const fts = [ftsOnly, shared]
  const vec = [shared, vecOnly]
  const fused = rrfFuse(fts, vec, 10, 0)
  expect(fused).toHaveLength(3)
  const sharedRow = fused.find((r) => r.id === 'shared')!
  // RRF for shared: rank 1 in fts → 1/(60+2), rank 0 in vec → 1/(60+1).
  const expectedShared = 1 / (RRF_K0 + 2) + 1 / (RRF_K0 + 1)
  expect(sharedRow.score).toBeCloseTo(expectedShared, 12)
  // shared has the highest fused score and should sort first.
  expect(fused[0]?.id).toBe('shared')
})

test('rrfFuse: same (type, id) across lists is treated as the same item', () => {
  // Identity is (type:id), not id alone — chunk:1 and transcript_segment:1
  // are different items even when their ids collide.
  const chunk = fakeResult('1', 100, 'chunk')
  const segment = fakeResult('1', 200, 'transcript_segment')
  const fused = rrfFuse([chunk], [segment], 10, 0)
  expect(fused).toHaveLength(2)
  expect(new Set(fused.map((r) => r.type))).toEqual(new Set(['chunk', 'transcript_segment']))
})

test('rrfFuse: tie-breaking — equal RRF scores fall back to time DESC then stable order', () => {
  // All items appear once at rank 0 in their respective lists → identical RRF.
  // Older + newer share scores; newer time should come first.
  const older = fakeResult('older', 100, 'chunk')
  const newer = fakeResult('newer', 999, 'chunk')
  const fused = rrfFuse([older], [newer], 10, 0)
  expect(fused.map((r) => r.id)).toEqual(['newer', 'older'])
  // And identical scores when only one list contributes preserve list order.
  const a = fakeResult('a', 500, 'chunk')
  const b = fakeResult('b', 500, 'chunk')
  const c = fakeResult('c', 500, 'chunk')
  const same = rrfFuse([a, b, c], [], 10, 0)
  // Different ranks → different scores, so this is really an ordering check.
  expect(same.map((r) => r.id)).toEqual(['a', 'b', 'c'])
})

test('rrfFuse: empty inputs return an empty list', () => {
  expect(rrfFuse([], [], 10, 0)).toEqual([])
})

test('rrfFuse: limit and offset paginate the fused ranking', () => {
  const fts = [
    fakeResult('a', 100, 'chunk'),
    fakeResult('b', 200, 'chunk'),
    fakeResult('c', 300, 'chunk'),
    fakeResult('d', 400, 'chunk'),
  ]
  expect(rrfFuse(fts, [], 2, 0).map((r) => r.id)).toEqual(['a', 'b'])
  expect(rrfFuse(fts, [], 2, 2).map((r) => r.id)).toEqual(['c', 'd'])
  // offset past the end returns []
  expect(rrfFuse(fts, [], 2, 10)).toEqual([])
})

test('rrfFuse: returned score replaces the input score', () => {
  const r = fakeResult('a', 1, 'chunk')
  r.score = 999 // simulate a BM25 score on the way in
  const [fused] = rrfFuse([r], [], 10, 0)
  expect(fused?.score).not.toBe(999)
  expect(fused?.score).toBeCloseTo(1 / (RRF_K0 + 1), 12)
})

// ---- Integration: end-to-end hybrid search through the read store ---------
//
// Most of these require sqlite-vec (vec0). The store reports vecReady=false
// when the extension can't load, so we skip gated cases instead of failing.

const dirs: string[] = []

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-fuse-'))
  dirs.push(dir)
  const dbPath = join(dir, 'index.db')
  return { dbPath, store: openChunkStore(dbPath) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('search: empty query is rejected before fusion runs', () => {
  const { dbPath, store } = freshStore()
  store.close()
  const read = new HyprmnesiaReadStore(dbPath)
  expect(() => read.search('', { mode: 'hybrid' })).toThrow(ReadStoreError)
  expect(() => read.search('   ', { mode: 'hybrid' })).toThrow(ReadStoreError)
  read.close()
})

test('search: hybrid without queryVector falls through to FTS5', () => {
  const { dbPath, store } = freshStore()
  const id = randomUUIDv7()
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: '/tmp/x.png',
    bytes: 10,
    text: 'unique-marker-zebra-aardvark',
    capture_ms: 1,
  })
  store.close()
  const read = new HyprmnesiaReadStore(dbPath)
  const out = read.search('zebra', { mode: 'hybrid' })
  expect(out.map((r) => r.id)).toContain(id)
  // No vec → fuse() is not entered → score keeps BM25 semantics (number, finite).
  expect(Number.isFinite(out[0]?.score ?? Number.NaN)).toBe(true)
  read.close()
})
