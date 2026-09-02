import { expect, test } from 'bun:test'
import { type CaptureEvent, EventBus } from '../core/events'
import type { ChunkStore } from '../store/db'
import { TranscriptionQueue } from './transcription_queue'
import type { PcmAudioFrame, TranscriptionCallbacks, TranscriptionEngine } from './types'

test('submitPcm drops frames while replay transcription is suppressed', async () => {
  const submitted: PcmAudioFrame[] = []
  const flushed: unknown[] = []
  let suppressed = false

  const engine: TranscriptionEngine = {
    name: 'test-asr',
    ready: async () => true,
    start: async () => {},
    submitPcm: (frame) => submitted.push(frame),
    flush: async (source) => {
      flushed.push(source ?? 'all')
    },
    stop: async () => {},
  }

  const queue = new TranscriptionQueue(engine, {} as ChunkStore, new EventBus(), {
    isReplaySuppressed: () => suppressed,
  })
  await queue.start()

  const frame: PcmAudioFrame = {
    source: 'system',
    chunkId: 'chunk-1',
    at: Date.UTC(2026, 0, 1),
    sampleRate: 16_000,
    pcm: Buffer.alloc(960),
  }

  queue.submitPcm(frame)
  expect(submitted).toHaveLength(1)

  suppressed = true
  queue.submitPcm(frame)
  queue.submitPcm(frame)
  await Promise.resolve()

  expect(submitted).toHaveLength(1)
  expect(flushed).toEqual(['system'])

  suppressed = false
  queue.submitPcm(frame)
  expect(submitted).toHaveLength(2)
})

test('handleStatus forwards model download progress to the event bus', async () => {
  const bus = new EventBus()
  const events: CaptureEvent[] = []
  bus.subscribe((e) => events.push(e))

  let captured: TranscriptionCallbacks | undefined
  const engine: TranscriptionEngine = {
    name: 'whisper:whisper-small',
    ready: async () => true,
    start: async (callbacks) => {
      captured = callbacks
    },
    submitPcm: () => {},
    flush: async () => {},
    stop: async () => {},
  }

  const queue = new TranscriptionQueue(engine, {} as ChunkStore, bus, {
    isReplaySuppressed: () => false,
  })
  await queue.start()

  captured?.onStatus({
    status: 'downloading',
    engine: 'whisper:whisper-small',
    message: 'downloading Whisper model',
    progress: 42,
  })

  const status = events.find((e) => e.type === 'transcription_status')
  expect(status).toMatchObject({
    type: 'transcription_status',
    status: 'downloading',
    engine: 'whisper:whisper-small',
    progress: 42,
  })
})
