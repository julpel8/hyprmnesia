import type { OcrEngine } from '../types'

export class NoopOcr implements OcrEngine {
  readonly name = 'noop'
  async ready() {
    return true
  }
  async process(_image: Buffer) {
    return ''
  }
}
