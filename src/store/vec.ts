// Helpers for the sqlite-vec loadable extension: locating the platform native
// library, loading it onto a bun:sqlite connection, and (de)serializing vectors
// as the compact little-endian float32 BLOB sqlite-vec expects.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IndexDb } from './index_db'

interface VecExtensionOptions {
  candidates?: readonly string[]
}

function libName(): string {
  if (process.platform === 'win32') return 'vec0.dll'
  if (process.platform === 'darwin') return 'vec0.dylib'
  return 'vec0.so'
}

function vecExtensionCandidates(): string[] {
  const name = libName()
  return [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'target', 'release', name),
  ]
}

function findVecExtension(
  candidates: readonly string[] = vecExtensionCandidates(),
): string | undefined {
  return candidates.find((p) => existsSync(p))
}

// Loads sqlite-vec onto the connection. Returns true on success; on any failure
// (missing library, load error) returns false so callers can degrade to FTS5.
export function loadVecExtension(db: IndexDb, opts: VecExtensionOptions = {}): boolean {
  const lib = findVecExtension(opts.candidates)
  if (!lib) return false
  try {
    db.loadExtension(lib)
    return true
  } catch {
    return false
  }
}

export function serializeVector(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
}
