// The point of this queue is that capture never waits on OCR. The tests below
// build a real index plus real blob files, then assert the two properties that
// keep it that way: a stored screenshot gets its text afterwards, and a row is
// retired from the queue even when the engine returns nothing or throws.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { EventBus } from '../core/events'
import { type ChunkStore, openChunkStore } from '../store/db'
import { HyprmnesiaReadStore } from '../store/read_store'
import { OcrQueue } from './ocr_queue'
import type { OcrEngine } from './types'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshHost(): { hostDir: string; store: ChunkStore } {
  const hostDir = mkdtempSync(join(tmpdir(), 'hpm-ocrq-'))
  dirs.push(hostDir)
  mkdirSync(join(hostDir, 'data'), { recursive: true })
  return { hostDir, store: openChunkStore(join(hostDir, 'index.db')) }
}

// A screenshot as capture leaves it: blob on disk, row with no text and no
// engine.
function seedShot(hostDir: string, store: ChunkStore, bytes = 'not-a-real-png'): string {
  const id = randomUUIDv7()
  const rel = join('data', `${id}.png`)
  writeFileSync(join(hostDir, rel), bytes)
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: rel,
    bytes: bytes.length,
    text: '',
    capture_ms: 1,
  })
  return id
}

function fakeEngine(process: OcrEngine['process'], name = 'fake'): OcrEngine {
  return { name, ready: async () => true, process }
}

async function drain(queue: OcrQueue, store: ChunkStore, until: () => boolean): Promise<void> {
  queue.start()
  for (let i = 0; i < 100 && !until(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await queue.stop()
}

test('reads the text of a stored screenshot and retires it from the queue', async () => {
  const { hostDir, store } = freshHost()
  try {
    const id = seedShot(hostDir, store)
    expect(store.pendingOcr(10).map((r) => r.id)).toEqual([id])

    const queue = new OcrQueue(
      fakeEngine(async () => 'bonjour'),
      store,
      new EventBus(),
      { hostDir },
    )
    await drain(queue, store, () => store.pendingOcr(10).length === 0)

    expect(store.pendingOcr(10)).toHaveLength(0)
    const read = new HyprmnesiaReadStore({ dbPath: join(hostDir, 'index.db'), hostDir })
    try {
      expect(read.recall(id, false).chunk?.text).toBe('bonjour')
    } finally {
      read.close()
    }
  } finally {
    store.close()
  }
})

// A blank screen reads as '' forever. Without writing the engine name the row
// would come back on every pass and the queue would spin on it.
test('retires a row whose text came back empty', async () => {
  const { hostDir, store } = freshHost()
  try {
    seedShot(hostDir, store)
    const queue = new OcrQueue(
      fakeEngine(async () => ''),
      store,
      new EventBus(),
      { hostDir },
    )
    await drain(queue, store, () => store.pendingOcr(10).length === 0)
    expect(store.pendingOcr(10)).toHaveLength(0)
  } finally {
    store.close()
  }
})

// A engine that throws (or a blob deleted under us) must not wedge the queue on
// the same row.
test('retires a row the engine could not read', async () => {
  const { hostDir, store } = freshHost()
  try {
    seedShot(hostDir, store)
    const queue = new OcrQueue(
      fakeEngine(async () => {
        throw new Error('engine exploded')
      }),
      store,
      new EventBus(),
      { hostDir },
    )
    await drain(queue, store, () => store.pendingOcr(10).length === 0)
    expect(store.pendingOcr(10)).toHaveLength(0)
  } finally {
    store.close()
  }
})

test('does nothing when OCR is disabled', async () => {
  const { hostDir, store } = freshHost()
  try {
    const id = seedShot(hostDir, store)
    const queue = new OcrQueue(
      fakeEngine(async () => 'unreachable', 'noop'),
      store,
      new EventBus(),
      { hostDir },
    )
    queue.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await queue.stop()
    expect(store.pendingOcr(10).map((r) => r.id)).toEqual([id])
  } finally {
    store.close()
  }
})
