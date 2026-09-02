import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pad } from '../util/format'

// A blob lives at <hostDir>/data/<kind>/<yyyy>/<mm>/<dd>/<id>.<ext>. The index
// stores the `rel` half only, so a row stays readable from any machine that has
// the host directory: the reader joins it back onto whichever host directory the
// row came from.
export interface BlobPath {
  abs: string
  rel: string
}

const BLOB_SUBDIR = 'data'

export interface BlobStore {
  path(kind: string, id: string, ext: string, at?: number): BlobPath
  write(kind: string, id: string, ext: string, data: Buffer, at?: number): Promise<BlobPath>
}

function partition(kind: string, at = Date.now()): string {
  const now = new Date(at)
  const yyyy = String(now.getUTCFullYear())
  const mm = pad(now.getUTCMonth() + 1)
  const dd = pad(now.getUTCDate())
  return join(BLOB_SUBDIR, kind, yyyy, mm, dd)
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

// `hostDir` is this machine's own directory inside the shared tree. Nothing here
// ever writes outside of it.
export function makeBlobStore(hostDir: string): BlobStore {
  const resolve = (kind: string, id: string, ext: string, at?: number): BlobPath => {
    const rel = join(partition(kind, at), `${id}.${ext}`)
    return { abs: join(hostDir, rel), rel }
  }
  return {
    path(kind, id, ext, at) {
      return resolve(kind, id, ext, at)
    },
    async write(kind, id, ext, data, at) {
      const blob = resolve(kind, id, ext, at)
      await ensureDir(join(hostDir, partition(kind, at)))
      await writeFile(blob.abs, data)
      return blob
    },
  }
}
