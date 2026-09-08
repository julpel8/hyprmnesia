import type { AudioSource, EventBus } from '../../core/events'
import type {
  PcmAudioFrame,
  TranscriptionCallbacks,
  TranscriptionEngine,
  TranscriptionStatus,
} from '../types'

// Runs a second ASR engine on the very same PCM frames as the first so both
// transcripts can be read side by side. Each engine owns its own hpm-asr
// process and its own model, and both are handed identical audio and identical
// segmentation settings, so their segments start and end on the same
// boundaries and line up as pairs in Live and Replay.
//
// The primary engine is the one that matters: its failure fails the pair, while
// the compare engine is best-effort. A compare engine that will not start, or
// dies mid-run, is reported as a warning and then ignored — recording keeps
// going on the primary transcript alone.
export class DualTranscription implements TranscriptionEngine {
  readonly name: string
  private compareLive = false

  constructor(
    private primary: TranscriptionEngine,
    private compare: TranscriptionEngine,
    private events?: EventBus,
  ) {
    this.name = `${primary.name}+${compare.name}`
  }

  async ready(): Promise<boolean> {
    const primaryReady = await this.primary.ready()
    if (!primaryReady) return false
    if (!(await this.compare.ready())) {
      this.warn(
        `compare engine ${this.compare.name} is not available; running ${this.primary.name} alone`,
      )
    }
    return true
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    await this.primary.start(callbacks)
    try {
      await this.compare.start(callbacks)
      this.compareLive = true
    } catch (err) {
      this.compareLive = false
      this.warn(`compare engine ${this.compare.name} failed to start: ${err}`)
      callbacks.onStatus({
        status: 'error',
        engine: this.compare.name,
        message: `compare engine failed to start: ${err}`,
      } satisfies TranscriptionStatus)
    }
  }

  submitPcm(frame: PcmAudioFrame): void {
    this.primary.submitPcm(frame)
    if (this.compareLive) this.compare.submitPcm(frame)
  }

  async flush(source?: AudioSource): Promise<void> {
    // The primary's flush is the one callers wait on for correctness; a compare
    // engine that stalls must not hold up a stop or a replay suppression.
    const compareFlush = this.compareLive
      ? this.compare.flush(source).catch((err) => {
          this.warn(`compare engine ${this.compare.name} flush failed: ${err}`)
        })
      : Promise.resolve()
    const [primary] = await Promise.allSettled([this.primary.flush(source), compareFlush])
    if (primary.status === 'rejected') throw primary.reason
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([
      this.primary.stop(),
      this.compareLive ? this.compare.stop() : Promise.resolve(),
    ])
    this.compareLive = false
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  private warn(message: string): void {
    this.events?.publish({ type: 'log', at: Date.now(), level: 'warn', message })
  }
}
