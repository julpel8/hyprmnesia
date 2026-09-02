import type { EngineConfig } from '../../config'
import type { OcrEngine } from '../types'
import { AutoOcr } from './auto'
import { NativeOcr } from './native'
import { NoopOcr } from './noop'
import { TesseractOcr, type TesseractOptions } from './tesseract'

function tesseractOptions(opts: Record<string, unknown>): TesseractOptions {
  return {
    lang: typeof opts.lang === 'string' ? opts.lang : undefined,
    binary: typeof opts.binary === 'string' ? opts.binary : undefined,
  }
}

export function makeOcr(cfg: EngineConfig): OcrEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopOcr()
    case 'native':
      return new NativeOcr()
    case 'tesseract':
      return new TesseractOcr(tesseractOptions(opts))
    case 'auto':
      return new AutoOcr(tesseractOptions(opts))
    default:
      throw new Error(`unknown ocr engine: ${cfg.engine}`)
  }
}
