import { expect, test } from 'bun:test'
import type { AudioSource } from '../../core/events'
import type {
  PcmAudioFrame,
  TranscriptionCallbacks,
  TranscriptionEngine,
  TranscriptionRole,
} from '../types'
import { DualTranscription } from './dual'

class FakeEngine implements TranscriptionEngine {
  frames: PcmAudioFrame[] = []
  flushes: Array<AudioSource | undefined> = []
  stopped = false
  started = false
  failStart?: Error
  failFlush?: Error
  private callbacks?: TranscriptionCallbacks

  constructor(
    readonly name: string,
    private role: TranscriptionRole = 'primary',
  ) {}

  async ready(): Promise<boolean> {
    return true
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    if (this.failStart) throw this.failStart
    this.callbacks = callbacks
    this.started = true
  }

  submitPcm(frame: PcmAudioFrame): void {
    this.frames.push(frame)
  }

  async flush(source?: AudioSource): Promise<void> {
    this.flushes.push(source)
    if (this.failFlush) throw this.failFlush
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  emit(text: string): void {
    this.callbacks?.onSegment({
      source: 'mic',
      chunkId: 'chunk-1',
      startAt: 1000,
      endAt: 2000,
      text,
      engine: this.name,
      transcribeMs: 1,
      role: this.role,
    })
  }
}

function frame(): PcmAudioFrame {
  return {
    source: 'mic',
    chunkId: 'chunk-1',
    at: 1000,
    sampleRate: 16000,
    pcm: Buffer.alloc(4),
  }
}

function collect(): TranscriptionCallbacks & { segments: Array<[string, string]> } {
  const segments: Array<[string, string]> = []
  return {
    segments,
    onSegment: (segment) => segments.push([segment.role, segment.text]),
    onStatus: () => {},
  }
}

test('both engines transcribe the same frames and report under their own role', async () => {
  const primary = new FakeEngine('parakeet:x')
  const compare = new FakeEngine('whisper:y', 'compare')
  const dual = new DualTranscription(primary, compare)
  expect(dual.name).toBe('parakeet:x+whisper:y')

  const callbacks = collect()
  await dual.start(callbacks)
  dual.submitPcm(frame())
  expect(primary.frames).toHaveLength(1)
  expect(compare.frames).toHaveLength(1)

  primary.emit('turnips')
  compare.emit('parsnips')
  expect(callbacks.segments).toEqual([
    ['primary', 'turnips'],
    ['compare', 'parsnips'],
  ])

  await dual.flush('mic')
  expect(compare.flushes).toEqual(['mic'])
  await dual.stop()
  expect(primary.stopped).toBe(true)
  expect(compare.stopped).toBe(true)
})

test('a compare engine that will not start is dropped, recording continues', async () => {
  const primary = new FakeEngine('parakeet:x')
  const compare = new FakeEngine('whisper:y', 'compare')
  compare.failStart = new Error('no model')
  const dual = new DualTranscription(primary, compare)

  await dual.start(collect())
  expect(primary.started).toBe(true)
  dual.submitPcm(frame())
  // Nothing is fed to an engine that never started.
  expect(primary.frames).toHaveLength(1)
  expect(compare.frames).toHaveLength(0)
  await dual.flush()
  expect(compare.flushes).toEqual([])
})

test('a failing compare flush does not fail the primary one', async () => {
  const primary = new FakeEngine('parakeet:x')
  const compare = new FakeEngine('whisper:y', 'compare')
  compare.failFlush = new Error('flush timed out')
  const dual = new DualTranscription(primary, compare)
  await dual.start(collect())
  await dual.flush('system')
  expect(primary.flushes).toEqual(['system'])
})

test('a failing primary flush still surfaces to the caller', async () => {
  const primary = new FakeEngine('parakeet:x')
  primary.failFlush = new Error('flush timed out')
  const dual = new DualTranscription(primary, new FakeEngine('whisper:y', 'compare'))
  await dual.start(collect())
  expect(dual.flush()).rejects.toThrow('flush timed out')
})
