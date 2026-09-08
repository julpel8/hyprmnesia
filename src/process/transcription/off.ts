import type { AudioSource } from '../../core/events'
import type { PcmAudioFrame, TranscriptionCallbacks, TranscriptionEngine } from '../types'

// `engine: off` — audio is still captured and stored, nothing is transcribed.
// It keeps the shape of an engine so the queue, the orchestrator and the status
// events need no special case for the disabled state.
export class DisabledTranscription implements TranscriptionEngine {
  readonly name = 'off'

  async ready(): Promise<boolean> {
    return true
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    callbacks.onStatus({ status: 'ready', engine: this.name, message: 'transcription off' })
  }

  submitPcm(_frame: PcmAudioFrame): void {}

  async flush(_source?: AudioSource): Promise<void> {}

  async stop(): Promise<void> {}
}
