// Unit tests for EmbeddingQueue: lifecycle, drain ordering, retry behavior on
// engine failures, and clean shutdown while a drain is in flight.
//
// The queue talks to two collaborators: a ChunkStore (vector availability +
// pending rows) and an EmbeddingEngine. Both are mocked here so the tests stay
// fast and don't depend on sqlite-vec or the ONNX sidecar.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type CaptureEvent, EventBus, type Source } from '../core/events'
import type { ChunkStore, EmbeddingKind, PendingEmbedding } from '../store/db'
import { EmbeddingQueue } from './embedding_queue'
import type {
  EmbeddingCallbacks,
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingStatus,
} from './types'

// ---- Test doubles ---------------------------------------------------------

interface FakeStoreOptions {
  vecEnabled?: boolean
  // Map of kind → queues of batches the store will hand out, one per
  // pendingEmbeddings() call. Empty/missing means "nothing pending".
  pending?: Partial<Record<EmbeddingKind, PendingEmbedding[][]>>
}

interface FakeStore extends ChunkStore {
  embeddings: Array<{ kind: EmbeddingKind; id: string; vector: Float32Array }>
  pendingCalls: Array<{ kind: EmbeddingKind; limit: number }>
}

function makeStore(opts: FakeStoreOptions = {}): FakeStore {
  const vecEnabled = opts.vecEnabled ?? true
  // Clone arrays so test cases can mutate the source list mid-test.
  const queues: Partial<Record<EmbeddingKind, PendingEmbedding[][]>> = {
    segment: opts.pending?.segment ? [...opts.pending.segment] : [],
    chunk: opts.pending?.chunk ? [...opts.pending.chunk] : [],
  }
  const store: FakeStore = {
    vecEnabled,
    embeddings: [],
    pendingCalls: [],
    insert: () => {
      throw new Error('insert not used in EmbeddingQueue tests')
    },
    finalizeAudioChunk: () => {
      throw new Error('finalizeAudioChunk not used in EmbeddingQueue tests')
    },
    insertTranscriptSegment: () => {
      throw new Error('insertTranscriptSegment not used in EmbeddingQueue tests')
    },
    updateText: () => {
      throw new Error('updateText not used in EmbeddingQueue tests')
    },
    pendingEmbeddings(kind, _model, limit) {
      store.pendingCalls.push({ kind, limit })
      const queue = queues[kind]
      if (!queue || queue.length === 0) return []
      const batch = queue.shift() ?? []
      // Respect the configured batchSize: never hand back more than asked.
      return batch.slice(0, limit)
    },
    insertEmbedding(row) {
      store.embeddings.push({ kind: row.kind, id: row.id, vector: row.vector })
    },
    close: () => {},
  }
  return store
}

interface FakeEngineOptions {
  ready?: boolean
  // Per-call overrides: each call to embed() consumes one entry from this
  // queue. The default behavior is to return one vector per request, in order.
  embedHandlers?: Array<(requests: EmbeddingRequest[]) => Promise<EmbeddingResult[]>>
}

interface FakeEngine extends EmbeddingEngine {
  startCalls: number
  stopCalls: number
  embedCalls: EmbeddingRequest[][]
  emitStatus(status: EmbeddingStatus): void
}

function makeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  let callbacks: EmbeddingCallbacks | undefined
  const handlers = opts.embedHandlers ? [...opts.embedHandlers] : []
  const defaultHandler = async (requests: EmbeddingRequest[]): Promise<EmbeddingResult[]> =>
    requests.map((r) => ({ id: r.id, kind: r.kind, vector: new Float32Array([0.1, 0.2, 0.3]) }))
  const engine: FakeEngine = {
    name: 'fake',
    dim: 3,
    startCalls: 0,
    stopCalls: 0,
    embedCalls: [],
    async ready() {
      return opts.ready ?? true
    },
    async start(cb) {
      engine.startCalls++
      callbacks = cb
    },
    async embed(requests) {
      engine.embedCalls.push(requests)
      const handler = handlers.shift() ?? defaultHandler
      return handler(requests)
    },
    async stop() {
      engine.stopCalls++
    },
    emitStatus(status) {
      callbacks?.onStatus(status)
    },
  }
  return engine
}

function pending(id: string, text = `text-${id}`): PendingEmbedding {
  return { id, text }
}

// ---- Fixtures -------------------------------------------------------------

const collectedEvents: CaptureEvent[] = []
let bus: EventBus
let unsubscribe: (() => void) | undefined

beforeEach(() => {
  collectedEvents.length = 0
  bus = new EventBus()
  unsubscribe = bus.subscribe((event) => collectedEvents.push(event))
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = undefined
})

const SOURCES_ALL: Source[] = ['screen', 'mic', 'system']

// Wait until predicate is true (polled with microtask yield). Used by tests
// that need to observe the loop completing a drain pass without depending on
// the queue's wall-clock idle/busy sleep intervals.
async function waitFor(check: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---- Tests ----------------------------------------------------------------

test('start() is a no-op when sqlite-vec is unavailable', async () => {
  const store = makeStore({ vecEnabled: false })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: SOURCES_ALL,
  })
  await queue.start()
  // No engine start, no drain.
  expect(engine.startCalls).toBe(0)
  expect(store.pendingCalls).toHaveLength(0)
  // A log event explaining the skip is emitted.
  const log = collectedEvents.find(
    (e) => e.type === 'log' && /semantic index unavailable/.test(e.message),
  )
  expect(log).toBeDefined()
  // stop() before any successful start must be a clean no-op (engine.stop is
  // best-effort, but the loop is never started so there's nothing to await).
  await queue.stop()
})

test('start() is a no-op when the engine reports not-ready', async () => {
  const store = makeStore()
  const engine = makeEngine({ ready: false })
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: SOURCES_ALL,
  })
  await queue.start()
  expect(engine.startCalls).toBe(0)
  expect(store.pendingCalls).toHaveLength(0)
  const log = collectedEvents.find(
    (e) => e.type === 'log' && /embedding engine .* not ready/.test(e.message),
  )
  expect(log).toBeDefined()
  await queue.stop()
})

test('drainOnce: items dequeue in the order pendingEmbeddings returns them', async () => {
  const items = [pending('a'), pending('b'), pending('c'), pending('d')]
  const store = makeStore({
    // segment: one batch then empty; chunk: nothing
    pending: { segment: [items], chunk: [] },
  })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['mic'],
  })
  await queue.start()
  await waitFor(() => store.embeddings.length === items.length, 'all items embedded')
  await queue.stop()

  expect(store.embeddings.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(store.embeddings.every((e) => e.kind === 'segment')).toBe(true)
  // The engine saw the same single batch in the same order.
  expect(engine.embedCalls).toHaveLength(1)
  expect(engine.embedCalls[0]?.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
})

test('drainOnce honors batchSize: never asks for more than the configured limit', async () => {
  const store = makeStore({
    pending: { segment: [[pending('s1')]], chunk: [[pending('c1')]] },
  })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 3, // <- the limit we expect to see at the store boundary
    sources: SOURCES_ALL,
  })
  await queue.start()
  await waitFor(() => store.embeddings.length === 2, 'segment + chunk embedded')
  await queue.stop()

  expect(store.pendingCalls.length).toBeGreaterThan(0)
  for (const call of store.pendingCalls) expect(call.limit).toBe(3)
})

test('only segments are drained when sources excludes screen', async () => {
  const store = makeStore({
    pending: { segment: [[pending('s1')]], chunk: [[pending('should-not-embed')]] },
  })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['mic'],
  })
  await queue.start()
  await waitFor(() => store.embeddings.length === 1, 'segment embedded')
  await queue.stop()

  expect(store.pendingCalls.every((c) => c.kind === 'segment')).toBe(true)
  expect(store.embeddings.map((e) => e.id)).toEqual(['s1'])
})

test('only chunks are drained when sources is screen-only', async () => {
  const store = makeStore({
    pending: { segment: [[pending('should-not-embed')]], chunk: [[pending('c1')]] },
  })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['screen'],
  })
  await queue.start()
  await waitFor(() => store.embeddings.length === 1, 'chunk embedded')
  await queue.stop()

  expect(store.pendingCalls.every((c) => c.kind === 'chunk')).toBe(true)
  expect(store.embeddings.map((e) => e.id)).toEqual(['c1'])
})

test('engine.embed() failure is caught, logged, and stop() still resolves cleanly', async () => {
  // When the engine throws, the loop swallows the error and emits a warn log
  // rather than crashing the daemon. (The queue sleeps IDLE_SLEEP_MS before
  // retrying — that timing is left to a longer-running integration test;
  // here we just assert that the failure is recoverable.)
  const items = [pending('a'), pending('b')]
  const store = makeStore({
    pending: { segment: [items], chunk: [] },
  })
  const engine = makeEngine({
    embedHandlers: [
      async () => {
        throw new Error('engine boom')
      },
    ],
  })
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['mic'],
  })
  await queue.start()
  // Wait until the embed call has been attempted and the catch has run.
  await waitFor(() => {
    return collectedEvents.some((e) => e.type === 'log' && /embedding drain failed/.test(e.message))
  }, 'error log emitted')
  // No vectors were written; the loop is still alive and can be stopped.
  expect(store.embeddings).toHaveLength(0)
  await Promise.race([
    queue.stop(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('stop() hung after error')), 2_000),
    ),
  ])
  expect(engine.stopCalls).toBe(1)
})

test('stop() resolves cleanly while a drain is in flight (no hang)', async () => {
  let resolveEmbed: ((value: EmbeddingResult[]) => void) | undefined
  const store = makeStore({
    pending: { segment: [[pending('slow')]], chunk: [] },
  })
  const engine = makeEngine({
    embedHandlers: [
      (requests) =>
        new Promise<EmbeddingResult[]>((resolve) => {
          resolveEmbed = () =>
            resolve(
              requests.map((r) => ({
                id: r.id,
                kind: r.kind,
                vector: new Float32Array([0, 0, 0]),
              })),
            )
        }),
    ],
  })
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['mic'],
  })
  await queue.start()
  // Wait until the queue has actually invoked embed() and is parked on it.
  await waitFor(() => engine.embedCalls.length === 1, 'embed() invoked')
  // Kick off stop() while embed() is still pending; it must not hang.
  const stopped = queue.stop()
  // Release the in-flight embed call so the loop unwinds.
  resolveEmbed?.([])
  // The stop() promise resolves within a reasonable timeout.
  await Promise.race([
    stopped,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop() hung')), 2_000)),
  ])
  expect(engine.stopCalls).toBe(1)
})

test('stop() called before start() is safe and does not throw', async () => {
  const store = makeStore({ vecEnabled: false })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: SOURCES_ALL,
  })
  await queue.stop()
  // engine.stop() is still attempted (best-effort), but no loop has been
  // started, so no events should land in the bus.
  expect(collectedEvents).toEqual([])
})

test('engine status callbacks are republished as embedding_status events', async () => {
  const store = makeStore({
    pending: { segment: [], chunk: [] },
  })
  const engine = makeEngine()
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: SOURCES_ALL,
  })
  await queue.start()
  engine.emitStatus({ status: 'ready', engine: 'fake', message: 'loaded' })
  await queue.stop()

  const status = collectedEvents.find(
    (e): e is Extract<CaptureEvent, { type: 'embedding_status' }> => e.type === 'embedding_status',
  )
  expect(status).toBeDefined()
  expect(status?.status).toBe('ready')
  expect(status?.engine).toBe('fake')
  expect(status?.message).toBe('loaded')
})

test('non-matching engine result kinds (e.g. "query") are skipped on the way to the store', async () => {
  // embed() is allowed to return EmbeddingResults with kind="query" (e.g. when
  // future callers reuse the same engine for query embeddings). The queue
  // currently filters those out so they never land in the vector tables.
  const store = makeStore({
    pending: { segment: [[pending('s1')]], chunk: [] },
  })
  const engine = makeEngine({
    embedHandlers: [
      async (requests) => [
        { id: requests[0]!.id, kind: 'segment', vector: new Float32Array([1, 0, 0]) },
        { id: 'phantom-query', kind: 'query', vector: new Float32Array([0, 1, 0]) },
      ],
    ],
  })
  const queue = new EmbeddingQueue(engine, store, bus, {
    model: 'm',
    dim: 3,
    batchSize: 8,
    sources: ['mic'],
  })
  await queue.start()
  await waitFor(() => store.embeddings.length === 1, 'segment embedded; query filtered')
  await queue.stop()

  expect(store.embeddings.map((e) => e.id)).toEqual(['s1'])
})
