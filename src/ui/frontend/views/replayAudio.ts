// Imperative WebAudio scheduler for replay playback, ported verbatim in behaviour
// from the original inline replay client. It schedules decoded audio buffers
// ahead of the playhead so mic/system tracks stay in sync with the scrubbing
// timeline. Kept outside React (refs/callbacks, not state) because it runs on the
// audio clock, not the render loop; the component drives it through accessors.

import type { ReplayChunk, ReplayManifest } from '../types'

const AUDIO_LOOKAHEAD_MS = 12_000

type Source = 'system' | 'mic'

export interface AudioAccessors {
  manifest: () => ReplayManifest | null
  currentMs: () => number
  playing: () => boolean
  speed: () => number
  enabled: (source: Source) => boolean
}

interface Track {
  buffers: Map<string, Promise<AudioBuffer | null>>
  sources: Map<string, { node: AudioBufferSourceNode }>
}

export class ReplayAudioEngine {
  private ctx: AudioContext | null = null
  private generation = 0
  private readonly tracks: Record<Source, Track> = {
    system: { buffers: new Map(), sources: new Map() },
    mic: { buffers: new Map(), sources: new Map() },
  }

  constructor(private readonly acc: AudioAccessors) {}

  private ensureContext(): AudioContext | null {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!this.ctx) this.ctx = new Ctor()
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    return this.ctx
  }

  private clearTrack(source: Source): void {
    for (const entry of this.tracks[source].sources.values()) {
      try {
        entry.node.stop()
      } catch {}
    }
    this.tracks[source].sources.clear()
  }

  // Invalidate any in-flight scheduling and silence both tracks. Called on
  // stop/pause and whenever the playhead jumps (seek, speed/track change).
  stop(): void {
    this.generation += 1
    this.clearTrack('system')
    this.clearTrack('mic')
  }

  reset(): void {
    this.stop()
  }

  private loadBuffer(source: Source, item: ReplayChunk): Promise<AudioBuffer | null> {
    const track = this.tracks[source]
    if (!item.blob_url) return Promise.resolve(null)
    let pending = track.buffers.get(item.id)
    if (!pending) {
      pending = fetch(item.blob_url, { cache: 'force-cache' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.arrayBuffer()
        })
        .then((data) => {
          const audioCtx = this.ensureContext()
          if (!audioCtx) return null
          return audioCtx.decodeAudioData(data.slice(0))
        })
        .catch((err) => {
          console.warn('Replay audio decode failed for', item.id, err)
          track.buffers.delete(item.id)
          return null
        })
      track.buffers.set(item.id, pending)
    }
    return pending
  }

  private scheduleItem(
    source: Source,
    item: ReplayChunk,
    buffer: AudioBuffer | null,
    seenGeneration: number,
  ): void {
    const manifest = this.acc.manifest()
    const currentMs = this.acc.currentMs()
    if (
      seenGeneration !== this.generation ||
      !buffer ||
      !manifest ||
      !this.acc.playing() ||
      !this.acc.enabled(source)
    )
      return
    if (item.offset_end_ms === null || item.offset_end_ms <= currentMs) return

    const track = this.tracks[source]
    if (track.sources.has(item.id)) return

    const audioCtx = this.ensureContext()
    if (!audioCtx) return

    const rate = Math.max(0.25, this.acc.speed() || 1)
    const startMs = Math.max(currentMs, item.offset_start_ms)
    const endMs = Math.min(item.offset_end_ms, manifest.duration_ms)
    const offsetMs = Math.max(0, item.blob_start_offset_ms + startMs - item.offset_start_ms)
    const availableMs = Math.max(0, buffer.duration * 1000 - offsetMs)
    const durationMs = Math.min(endMs - startMs, availableMs)
    if (durationMs <= 0) return

    const node = audioCtx.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = rate
    node.connect(audioCtx.destination)

    const when = audioCtx.currentTime + Math.max(0, (startMs - currentMs) / 1000 / rate)
    node.onended = () => {
      const current = track.sources.get(item.id)
      if (current?.node === node) track.sources.delete(item.id)
    }
    track.sources.set(item.id, { node })

    try {
      node.start(when, offsetMs / 1000, durationMs / 1000)
    } catch (err) {
      track.sources.delete(item.id)
      console.warn('Replay audio schedule failed for', item.id, err)
    }
  }

  private syncTrack(source: Source): void {
    const manifest = this.acc.manifest()
    if (!manifest || !this.acc.playing() || !this.acc.enabled(source)) {
      this.clearTrack(source)
      return
    }

    const currentMs = this.acc.currentMs()
    const rate = Math.max(0.25, this.acc.speed() || 1)
    const horizonMs = currentMs + AUDIO_LOOKAHEAD_MS * rate
    const seenGeneration = this.generation

    for (const item of manifest.audio[source]) {
      if (!item.blob_url || item.offset_end_ms === null) continue
      if (item.offset_start_ms > horizonMs) break
      if (item.offset_end_ms <= currentMs) continue
      if (this.tracks[source].sources.has(item.id)) continue

      this.loadBuffer(source, item).then((buffer) => {
        this.scheduleItem(source, item, buffer, seenGeneration)
      })
    }
  }

  sync(): void {
    this.syncTrack('system')
    this.syncTrack('mic')
  }
}
