import type { EmbeddingCallbacks, EmbeddingEngine, EmbeddingRequest } from '../types'

// Embeddings disabled: indexing becomes a no-op and search degrades to FTS5.
export class NoopEmbedding implements EmbeddingEngine {
  readonly name = 'noop'
  readonly dim = 0

  async ready(): Promise<boolean> {
    return false
  }

  async start(callbacks: EmbeddingCallbacks): Promise<void> {
    callbacks.onStatus({ status: 'stopped', engine: this.name, message: 'embeddings disabled' })
  }

  async embed(_requests: EmbeddingRequest[]): Promise<[]> {
    return []
  }

  async stop(): Promise<void> {}
}
