import type { AudioSource } from '../../core/events'
import type { PcmAudioFrame, TranscriptionCallbacks, TranscriptionEngine } from '../types'

export class NoopTranscription implements TranscriptionEngine {
  readonly name = 'noop'
  async ready() {
    return true
  }
  async start(callbacks: TranscriptionCallbacks) {
    callbacks.onStatus({ status: 'ready', engine: this.name, message: 'noop transcription ready' })
  }
  submitPcm(_frame: PcmAudioFrame) {}
  async flush(_source?: AudioSource) {}
  async stop() {}
}
