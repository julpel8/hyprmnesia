import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from '../../store/db'
import { HyprmnesiaReadStore } from './index'

const dirs: string[] = []

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-rs-'))
  dirs.push(dir)
  const dbPath = join(dir, 'index.db')
  const store = openChunkStore(dbPath)
  return { dbPath, store }
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

test('search falls back to FTS5 for hybrid mode when no query vector is present', () => {
  const { dbPath, store } = freshStore()
  const chunkId = randomUUIDv7()
  store.insert({
    id: chunkId,
    kind: 'screenshot',
    at: Date.now(),
    blob: '/tmp/x.png',
    bytes: 10,
    text: 'invoice overview dashboard',
    capture_ms: 1,
  })
  store.close()

  const read = new HyprmnesiaReadStore(dbPath)
  const hybrid = read.search('invoice', { mode: 'hybrid' })
  expect(hybrid.map((r) => r.id)).toContain(chunkId)

  const lexical = read.search('invoice', { mode: 'lexical' })
  expect(lexical.map((r) => r.id)).toContain(chunkId)

  read.close()
})

test('search returns transcript segments via FTS5 fallback', () => {
  const { dbPath, store } = freshStore()
  const chunkId = randomUUIDv7()
  const now = Date.now()
  store.insert({
    id: chunkId,
    kind: 'audio_mic',
    at: now,
    start_at: now,
    end_at: now,
    blob: '/tmp/a.wav',
    bytes: 10,
    text: '',
    capture_ms: 1,
    audio: { engine: 'parakeet', device: 'default', sample_rate: 16000, chunk_ms: 5000 },
  })
  const segId = randomUUIDv7()
  store.insertTranscriptSegment({
    id: segId,
    chunk_id: chunkId,
    source: 'mic',
    start_at: now,
    end_at: now + 1000,
    text: 'discussing the quarterly billing report',
    engine: 'parakeet',
    transcribe_ms: 5,
  })
  store.close()

  const read = new HyprmnesiaReadStore(dbPath)
  const results = read.search('billing', { mode: 'semantic' })
  expect(results.map((r) => r.id)).toContain(segId)
  read.close()
})
