import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { openReadIndexDb } from './index_db'

// Publishes the live index DB as a single consistent file for the other
// machines to read.
//
// The live DB runs in WAL mode, so its -wal and -shm sidecars carry committed
// data that index.db alone does not have; copying the file would hand the other
// machines a truncated, possibly corrupt database. `VACUUM INTO` writes a fully
// checkpointed, WAL-free copy instead, and the rename onto the final name is
// atomic, so Syncthing never picks up a half-written file.
export function publishSnapshot(livePath: string, destPath: string): void {
  const tmp = `${destPath}.tmp`
  mkdirSync(dirname(destPath), { recursive: true })
  rmSync(tmp, { force: true })
  const db = openReadIndexDb(livePath)
  try {
    db.query(`VACUUM INTO ${quote(tmp)}`).run()
  } finally {
    db.close()
  }
  renameSync(tmp, destPath)
}

// VACUUM INTO takes a literal, not a bound parameter.
function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}
