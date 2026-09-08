import type { AudioSource } from '../../core/events'

// Cuts a continuous PCM stream into stretches of speech, one per source. This
// is the job the Rust worker used to do with webrtc-vad; the GPU engines are
// plain transcribe-this-buffer servers, so the daemon owns segmentation now.
//
// Voice detection is an energy gate with a hangover, rather than webrtc-vad:
// there is no VAD binding for this runtime, and the gate the Rust worker
// already applied before its VAD (`rms_gate`) was doing most of the filtering.
// The knobs are the same ones as before so an existing config keeps its meaning.

export interface SegmenterOptions {
  sampleRate: number
  // A segment is only transcribed once it holds this much actual voice, which
  // keeps near-silence away from the model. Whisper in particular answers
  // silence with canned filler ("Merci d'avoir regardé", "Thank you.").
  minSegmentMs: number
  // Close a segment once it reaches this length, even mid-speech.
  targetSegmentMs: number
  // Hard cap, so one unbroken talker cannot grow a segment without end.
  maxSegmentMs: number
  // Silence this long closes the current segment.
  silenceMs: number
  // Frames quieter than this never count as voice.
  rmsGate: number
}

export interface PendingSegment {
  source: AudioSource
  chunkId: string
  startAt: number
  endAt: number
  samples: Float32Array
}

interface Frame {
  chunkId: string
  at: number
  samples: Float32Array
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

// One source's worth of state. Mic and system audio are segmented separately:
// they are different streams that happen to share a clock.
class SourceSegmenter {
  private samples: number[] = []
  private chunkId?: string
  private startAt?: number
  private endAt?: number
  private silenceMs = 0
  private voicedSamples = 0

  constructor(
    private readonly source: AudioSource,
    private readonly opts: SegmenterOptions,
  ) {}

  push(frame: Frame): PendingSegment[] {
    const ready: PendingSegment[] = []
    // A new capture chunk starts a new segment: the segment carries a chunk id
    // and the store links it to that row.
    if (this.chunkId !== undefined && this.chunkId !== frame.chunkId) {
      const closed = this.take(false)
      if (closed) ready.push(closed)
    }

    const frameMs = (frame.samples.length / this.opts.sampleRate) * 1000
    const frameEnd = frame.at + frameMs
    const voiced = rms(frame.samples) >= this.opts.rmsGate

    if (voiced) {
      if (this.samples.length === 0) {
        this.chunkId = frame.chunkId
        this.startAt = frame.at
      }
      this.append(frame.samples)
      this.voicedSamples += frame.samples.length
      this.endAt = frameEnd
      this.silenceMs = 0
      const durationMs = (this.samples.length / this.opts.sampleRate) * 1000
      if (durationMs >= this.opts.targetSegmentMs || durationMs >= this.opts.maxSegmentMs) {
        const closed = this.take(false)
        if (closed) ready.push(closed)
      }
    } else if (this.samples.length > 0) {
      // Keep the quiet frames between words: speech is full of pauses, breaths
      // and unvoiced consonants, and dropping them shortens segments below
      // minSegmentMs until transcripts disappear.
      this.append(frame.samples)
      this.endAt = frameEnd
      this.silenceMs += frameMs
      if (this.silenceMs >= this.opts.silenceMs) {
        const closed = this.take(false)
        if (closed) ready.push(closed)
      }
    }

    return ready
  }

  flush(): PendingSegment | undefined {
    return this.take(true)
  }

  private append(samples: Float32Array): void {
    for (const sample of samples) this.samples.push(sample)
  }

  private take(force: boolean): PendingSegment | undefined {
    if (this.samples.length === 0 || this.chunkId === undefined) return undefined
    const voicedMs = (this.voicedSamples / this.opts.sampleRate) * 1000
    if (!force && voicedMs < this.opts.minSegmentMs) {
      this.reset()
      return undefined
    }
    const segment: PendingSegment = {
      source: this.source,
      chunkId: this.chunkId,
      startAt: this.startAt ?? 0,
      endAt: this.endAt ?? this.startAt ?? 0,
      samples: Float32Array.from(this.samples),
    }
    this.reset()
    return segment
  }

  private reset(): void {
    this.samples = []
    this.chunkId = undefined
    this.startAt = undefined
    this.endAt = undefined
    this.silenceMs = 0
    this.voicedSamples = 0
  }
}

export class Segmenter {
  private sources = new Map<AudioSource, SourceSegmenter>()

  constructor(private readonly opts: SegmenterOptions) {}

  push(source: AudioSource, chunkId: string, at: number, samples: Float32Array): PendingSegment[] {
    return this.for(source).push({ chunkId, at, samples })
  }

  // Closes whatever is buffered, for one source or all of them. Called when
  // capture stops or replay audio takes over the speakers.
  flush(source?: AudioSource): PendingSegment[] {
    const out: PendingSegment[] = []
    for (const [key, segmenter] of this.sources) {
      if (source && key !== source) continue
      const segment = segmenter.flush()
      if (segment) out.push(segment)
    }
    return out
  }

  private for(source: AudioSource): SourceSegmenter {
    const existing = this.sources.get(source)
    if (existing) return existing
    const created = new SourceSegmenter(source, this.opts)
    this.sources.set(source, created)
    return created
  }
}

// 16-bit PCM is what capture hands over; the servers want a WAV file body.
export function pcmToFloat32(pcm: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(pcm.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

export function samplesToWav(samples: Float32Array, sampleRate: number): Buffer {
  const body = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number))
    body.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + body.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(body.length, 40)
  return Buffer.concat([header, body])
}
