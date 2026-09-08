import type { EngineConfig } from '../../config'
import type { OcrEngine } from '../types'
import { TesseractOcr, type TesseractOptions } from './tesseract'

function tesseractOptions(opts: Record<string, unknown>): TesseractOptions {
  return {
    lang: typeof opts.lang === 'string' ? opts.lang : undefined,
    binary: typeof opts.binary === 'string' ? opts.binary : undefined,
  }
}

export function makeOcr(cfg: EngineConfig): OcrEngine {
  const opts = cfg.options ?? {}
  switch (
    cfg.engine // plus que tesseract avec linux, mais on peut ajouter d'autres moteurs plus tard...
  ) {
    default:
      return new TesseractOcr(tesseractOptions(opts))
  }
}
