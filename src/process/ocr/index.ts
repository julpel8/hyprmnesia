import type { EngineConfig } from '../../config'
import type { OcrEngine } from '../types'
import { HailoOcr, type HailoOptions } from './hailo'
import { NoopOcr } from './noop'
import { RapidOcr, type RapidOcrOptions } from './rapidocr'
import { TesseractOcr, type TesseractOptions } from './tesseract'

function tesseractOptions(opts: Record<string, unknown>): TesseractOptions {
  return {
    lang: typeof opts.lang === 'string' ? opts.lang : undefined,
    binary: typeof opts.binary === 'string' ? opts.binary : undefined,
  }
}

function hailoOptions(opts: Record<string, unknown>): HailoOptions {
  return {
    scale: typeof opts.scale === 'number' ? opts.scale : undefined,
    min_conf: typeof opts.min_conf === 'number' ? opts.min_conf : undefined,
    det_model: typeof opts.det_model === 'string' ? opts.det_model : undefined,
    rec_model: typeof opts.rec_model === 'string' ? opts.rec_model : undefined,
    python: typeof opts.python === 'string' ? opts.python : undefined,
  }
}

function rapidOcrOptions(opts: Record<string, unknown>): RapidOcrOptions {
  return {
    scale: typeof opts.scale === 'number' ? opts.scale : undefined,
    min_conf: typeof opts.min_conf === 'number' ? opts.min_conf : undefined,
    det_limit_side_len:
      typeof opts.det_limit_side_len === 'number' ? opts.det_limit_side_len : undefined,
    backend: typeof opts.backend === 'string' ? opts.backend : undefined,
    python: typeof opts.python === 'string' ? opts.python : undefined,
  }
}

export function makeOcr(cfg: EngineConfig): OcrEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopOcr()
    // PaddleOCR on a Hailo NPU; requires the bundled python worker, the HEF
    // models and a /dev/hailo device. 'auto' (and anything unknown) stays on
    // tesseract, which runs everywhere.
    case 'hailo':
      return new HailoOcr(hailoOptions(opts))
    // PaddleOCR on the CPU (OpenVINO or onnxruntime backend); needs a python
    // interpreter with rapidocr_openvino or rapidocr_onnxruntime installed.
    case 'rapidocr':
      return new RapidOcr(rapidOcrOptions(opts))
    default:
      return new TesseractOcr(tesseractOptions(opts))
  }
}
