import type { OcrEngine } from '../types'

// Explicitly disables OCR: screenshots are stored without text.
export class NoopOcr implements OcrEngine {
  readonly name = 'noop'
  async ready() {
    return true
  }
  async process(_image: Buffer) {
    return ''
  }
}
