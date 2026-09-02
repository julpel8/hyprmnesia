import { randomUUIDv7 } from 'bun'
import type { AudioCaptureConfig, AudioStreamConfig } from '../config'
import type { AudioSource, EventBus, WindowContext } from '../core/events'
import type { TranscriptionQueue } from '../process/transcription_queue'
import type { BlobPath, BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import {
  chunkKind,
  type EchoSuppressionRuntime,
  finiteLevel,
  makeEchoSuppression,
  peakOrFloor,
  shouldSubmitAsrFrame,
} from './audio_echo'
import {
  makeProcessShutdown,
  type ProcessShutdown,
  type ResolvedPcmSource,
  resolvePcmSource,
} from './audio_process'
import { encodePcm16WebmOpus } from './ffmpeg'
import type { SckBus } from './sck'
import { encodePcm16Wav, pcm16Levels } from './wav'

export interface AudioCaptureDeps {
  cfg: AudioCaptureConfig
  blobs: BlobStore
  store: ChunkStore
  transcription: TranscriptionQueue
  events: EventBus
  sck?: SckBus
  getWindow?: () => WindowContext | undefined
}

export interface CaptureRunner {
  stop: () => void
  done: Promise<void>
}

interface AudioStreamDeps {
  blobs: BlobStore
  store: ChunkStore
  transcription: TranscriptionQueue
  events: EventBus
  echo: EchoSuppressionRuntime
  storageFormat: AudioBlobExt
  storageBitrateKbps: number
  getWindow?: () => WindowContext | undefined
}

const LEVEL_THROTTLE_MS = 100
const ASR_FRAME_MS = 30
const BYTES_PER_SAMPLE = 2
type AudioBlobExt = 'wav' | 'webm'

const NOOP_RUNNER: CaptureRunner = { stop: () => {}, done: Promise.resolve() }

interface AudioChunkState {
  id: string
  kind: 'audio_mic' | 'audio_system'
  startAt: number
  blob: BlobPath
  window?: WindowContext
  parts: Buffer[]
  samples: number
  inserted: boolean
}

interface AudioConsumer {
  appendPcm: (pcm: Buffer) => Promise<void>
  finalize: () => Promise<void>
}

function makeAudioConsumer(
  args: {
    source: AudioSource
    device: string
    sampleRate: number
    chunkMs: number
  } & AudioStreamDeps,
): AudioConsumer {
  const {
    source,
    device,
    sampleRate,
    chunkMs,
    storageFormat,
    storageBitrateKbps,
    blobs,
    store,
    transcription,
    events,
    echo,
    getWindow,
  } = args
  const chunkSamples = Math.max(1, Math.floor((chunkMs / 1000) * sampleRate))
  const asrFrameBytes = Math.max(
    BYTES_PER_SAMPLE,
    Math.floor((ASR_FRAME_MS / 1000) * sampleRate) * BYTES_PER_SAMPLE,
  )
  const streamStartAt = Date.now()
  let samplesSeen = 0
  let current: AudioChunkState | undefined
  let asrPending = Buffer.alloc(0)
  let asrPendingAt: number | undefined
  let lastLevelAt = 0
  let warnedOpusFallback = false
  let opusUnavailable = false
  let finalizeQueue: Promise<void> = Promise.resolve()

  const encodeStoredAudio = async (
    pcm: Buffer,
  ): Promise<{ data: Buffer; ext: AudioBlobExt; fallback?: string }> => {
    if (storageFormat === 'webm' && !opusUnavailable) {
      try {
        const data = await encodePcm16WebmOpus(pcm, sampleRate, { bitrateKbps: storageBitrateKbps })
        return { data, ext: 'webm' }
      } catch (err) {
        opusUnavailable = true
        return { data: encodePcm16Wav(pcm, sampleRate), ext: 'wav', fallback: String(err) }
      }
    }
    return { data: encodePcm16Wav(pcm, sampleRate), ext: 'wav' }
  }

  const ensureChunk = (at: number): AudioChunkState => {
    if (current) return current
    const id = randomUUIDv7()
    const kind = chunkKind(source)
    const blob = blobs.path(kind, id, storageFormat, at)
    const window = getWindow?.()
    current = { id, kind, startAt: at, blob, window, parts: [], samples: 0, inserted: false }
    return current
  }

  // Defer the DB row until the chunk actually has audio. Avoids orphan rows
  // when a stream stops between ensureChunk and the first sample arriving.
  const insertChunkRow = (chunk: AudioChunkState) => {
    if (chunk.inserted) return
    chunk.inserted = true
    store.insert({
      id: chunk.id,
      kind: chunk.kind,
      at: chunk.startAt,
      start_at: chunk.startAt,
      end_at: chunk.startAt,
      blob: chunk.blob.rel,
      bytes: 0,
      text: '',
      capture_ms: 0,
      window: chunk.window,
      audio: {
        engine: 'pending',
        device,
        sample_rate: sampleRate,
        chunk_ms: chunkMs,
      },
    })
  }

  const flushAsrBoundary = () => {
    asrPending = Buffer.alloc(0)
    asrPendingAt = undefined
    transcription.flush(source).catch((err) => {
      events.publish({ type: 'error', source, at: Date.now(), message: `ASR flush failed: ${err}` })
    })
  }

  const finalizeChunk = async (chunk: AudioChunkState) => {
    const pcm = Buffer.concat(chunk.parts)
    const encoded = await encodeStoredAudio(pcm)
    if (encoded.fallback && !warnedOpusFallback) {
      warnedOpusFallback = true
      events.publish({
        type: 'log',
        at: Date.now(),
        level: 'warn',
        message: `audio opus encode failed; storing ${source} chunks as wav: ${encoded.fallback}`,
      })
    }
    const blob = await blobs.write(chunk.kind, chunk.id, encoded.ext, encoded.data, chunk.startAt)
    chunk.blob = blob
    const endAt = chunk.startAt + Math.round((chunk.samples / sampleRate) * 1000)
    const levels = pcm16Levels(pcm)
    const rms_db = finiteLevel(levels.rms_db)
    const peak_db = finiteLevel(levels.peak_db)
    store.finalizeAudioChunk(chunk.id, {
      blob: blob.rel,
      bytes: encoded.data.length,
      capture_ms: Date.now() - chunk.startAt,
      end_at: endAt,
      rms_db,
      peak_db,
    })
    events.publish({
      type: 'chunk',
      source,
      at: endAt,
      id: chunk.id,
      path: blob.abs,
      bytes: encoded.data.length,
      text_len: 0,
      capture_ms: Date.now() - chunk.startAt,
      window: chunk.window,
      rms_db,
      peak_db,
    })
  }

  const queueFinalizeChunk = (chunk: AudioChunkState | undefined) => {
    if (!chunk || !chunk.inserted) return
    finalizeQueue = finalizeQueue
      .then(() => finalizeChunk(chunk))
      .catch((err) => {
        events.publish({
          type: 'error',
          source,
          at: Date.now(),
          message: `audio chunk finalize failed: ${String(err)}`,
        })
      })
  }

  const rotateChunk = () => {
    const chunk = current
    current = undefined
    queueFinalizeChunk(chunk)
  }

  const feedAsr = (chunkId: string, pcm: Buffer, at: number) => {
    if (asrPending.length === 0) asrPendingAt = at
    asrPending = Buffer.concat([asrPending, pcm])
    while (asrPending.length >= asrFrameBytes && asrPendingAt !== undefined) {
      const frame = asrPending.subarray(0, asrFrameBytes)
      if (shouldSubmitAsrFrame(source, asrPendingAt, frame, echo)) {
        transcription.submitPcm({
          source,
          chunkId,
          at: asrPendingAt,
          sampleRate,
          pcm: frame,
        })
      }
      asrPending = asrPending.subarray(asrFrameBytes)
      asrPendingAt += ASR_FRAME_MS
    }
  }

  const appendPcm = async (pcm: Buffer) => {
    let offset = 0
    while (offset < pcm.length) {
      const sampleAt = streamStartAt + Math.round((samplesSeen / sampleRate) * 1000)
      const chunk = ensureChunk(sampleAt)
      const remainingSamples = chunkSamples - chunk.samples
      const remainingBytes = remainingSamples * BYTES_PER_SAMPLE
      const takeBytes = Math.min(remainingBytes, pcm.length - offset)
      const part = pcm.subarray(offset, offset + takeBytes)
      const partAt = chunk.startAt + Math.round((chunk.samples / sampleRate) * 1000)
      const newSamples = Math.floor(part.length / BYTES_PER_SAMPLE)

      chunk.parts.push(part)
      chunk.samples += newSamples
      samplesSeen += newSamples
      if (newSamples > 0) insertChunkRow(chunk)
      feedAsr(chunk.id, part, partAt)

      const now = Date.now()
      if (now - lastLevelAt >= LEVEL_THROTTLE_MS) {
        lastLevelAt = now
        const levels = pcm16Levels(part)
        events.publish({
          type: 'audio_level',
          source,
          at: now,
          rms_db: peakOrFloor(levels.peak_db),
        })
      }

      offset += takeBytes
      if (chunk.samples >= chunkSamples) {
        flushAsrBoundary()
        rotateChunk()
      }
    }
  }

  const finalize = async () => {
    flushAsrBoundary()
    rotateChunk()
    await finalizeQueue
    await transcription.flush(source).catch((err) => {
      events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `ASR final flush failed: ${err}`,
      })
    })
  }

  return { appendPcm, finalize }
}

function publishDisabled(events: EventBus, source: AudioSource): CaptureRunner {
  events.publish({
    type: 'log',
    at: Date.now(),
    level: 'info',
    message: `${source} capture disabled`,
  })
  return NOOP_RUNNER
}

export const __testing = { makeAudioConsumer, makeProcessShutdown }

function startSckSystemStream(
  stream: AudioStreamConfig,
  sampleRate: number,
  sck: SckBus,
  deps: AudioStreamDeps,
): CaptureRunner {
  const source: AudioSource = 'system'
  if (!stream.enabled) return publishDisabled(deps.events, source)

  let running = true
  let unsubscribe: (() => void) | undefined
  let resolveStopped!: () => void
  const stoppedSignal = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  const done = (async () => {
    const consumer = makeAudioConsumer({
      source,
      device: 'sck',
      sampleRate,
      chunkMs: stream.chunk_ms,
      ...deps,
    })

    try {
      await sck.start()
    } catch (err) {
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `sck start failed: ${String(err)}`,
      })
      return
    }

    if (!running) return

    deps.events.publish({
      type: 'started',
      source,
      at: Date.now(),
      meta: {
        mode: 'pcm',
        chunk_ms: stream.chunk_ms,
        device: 'sck',
        sample_rate: sampleRate,
        storage_format: deps.storageFormat,
        storage_bitrate_kbps: deps.storageBitrateKbps,
      },
    })

    let appending: Promise<void> = Promise.resolve()
    unsubscribe = sck.onAudio((event) => {
      appending = appending
        .then(() => consumer.appendPcm(event.pcm))
        .catch((err) => {
          deps.events.publish({
            type: 'error',
            source,
            at: Date.now(),
            message: `sck appendPcm: ${String(err)}`,
          })
        })
    })

    await stoppedSignal

    unsubscribe?.()
    unsubscribe = undefined
    await appending.catch(() => {})
    await consumer.finalize()
    deps.events.publish({ type: 'stopped', source, at: Date.now() })
  })()

  return {
    done,
    stop: () => {
      if (!running) return
      running = false
      resolveStopped()
    },
  }
}

function startStream(
  source: AudioSource,
  stream: AudioStreamConfig,
  sampleRate: number,
  deps: AudioStreamDeps,
): CaptureRunner {
  if (!stream.enabled) return publishDisabled(deps.events, source)

  let running = true
  let stopRequested = false
  let currentProc: ProcessShutdown | null = null

  const done = (async () => {
    let resolved: ResolvedPcmSource
    try {
      resolved = await resolvePcmSource(source, stream, sampleRate)
    } catch (err) {
      deps.events.publish({ type: 'error', source, at: Date.now(), message: String(err) })
      return
    }
    const { bin, args, device, label } = resolved
    if (resolved.warn) {
      deps.events.publish({ type: 'log', at: Date.now(), level: 'warn', message: resolved.warn })
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([bin, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
    } catch (err) {
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `failed to spawn ${label} (${source}): ${String(err)}`,
      })
      return
    }
    const shutdown = makeProcessShutdown(proc, label, source, deps.events)
    currentProc = shutdown
    const stderrText =
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve('')
    if (!(proc.stdout instanceof ReadableStream)) {
      shutdown.terminate()
      currentProc = null
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `${label} (${source}) did not expose a readable PCM stdout stream`,
      })
      return
    }

    deps.events.publish({
      type: 'started',
      source,
      at: Date.now(),
      meta: {
        mode: 'pcm',
        chunk_ms: stream.chunk_ms,
        device,
        sample_rate: sampleRate,
        storage_format: deps.storageFormat,
        storage_bitrate_kbps: deps.storageBitrateKbps,
        ...(resolved.backend ? { backend: resolved.backend } : {}),
      },
    })

    const consumer = makeAudioConsumer({
      source,
      device,
      sampleRate,
      chunkMs: stream.chunk_ms,
      ...deps,
    })

    const reader = proc.stdout.getReader()
    try {
      while (running) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone) break
        if (value?.length) await consumer.appendPcm(Buffer.from(value))
      }
    } catch (err) {
      if (running) {
        deps.events.publish({ type: 'error', source, at: Date.now(), message: String(err) })
      }
    } finally {
      const intentionallyStopped = stopRequested
      running = false
      await consumer.finalize()

      const exit = await shutdown.exited
      currentProc = null
      const stderr = await stderrText.catch(() => '')
      if (!intentionallyStopped && exit !== 0 && stderr.trim()) {
        deps.events.publish({
          type: 'error',
          source,
          at: Date.now(),
          message: `${label} (${source}) exited ${exit}: ${stderr.trim()}`,
        })
      }
      deps.events.publish({ type: 'stopped', source, at: Date.now() })
    }
  })()

  return {
    done,
    stop: () => {
      stopRequested = true
      running = false
      currentProc?.terminate()
    },
  }
}

export function startAudioCapture({
  cfg,
  blobs,
  store,
  transcription,
  events,
  sck,
  getWindow,
}: AudioCaptureDeps): CaptureRunner {
  const echo = makeEchoSuppression(cfg)
  const streamDeps: AudioStreamDeps = {
    blobs,
    store,
    transcription,
    events,
    echo,
    storageFormat: cfg.format,
    storageBitrateKbps: cfg.bitrate_kbps,
    getWindow,
  }
  const mic = startStream('mic', cfg.mic, cfg.sample_rate, streamDeps)
  const system =
    process.platform === 'darwin' && cfg.system.enabled && sck
      ? startSckSystemStream(cfg.system, cfg.sample_rate, sck, streamDeps)
      : startStream('system', cfg.system, cfg.sample_rate, streamDeps)
  return {
    done: Promise.allSettled([mic.done, system.done]).then(() => {}),
    stop: () => {
      mic.stop()
      system.stop()
    },
  }
}
