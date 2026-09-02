import type { EngineConfig } from '../../config'
import type { EventBus } from '../../core/events'
import type { EmbeddingEngine } from '../types'
import { LocalEmbedding, type LocalEmbeddingOptions } from './local'
import { NoopEmbedding } from './noop'

function localOptionsFrom(opts: Record<string, unknown>): LocalEmbeddingOptions {
  return {
    model: typeof opts.model === 'string' ? opts.model : undefined,
    dim: typeof opts.dim === 'number' ? opts.dim : undefined,
  }
}

export function makeEmbedding(cfg: EngineConfig, events?: EventBus): EmbeddingEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopEmbedding()
    case 'local':
      return new LocalEmbedding(localOptionsFrom(opts), events)
    default:
      return new NoopEmbedding()
  }
}
