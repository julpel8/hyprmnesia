import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { CURRENT_INDEX_SCHEMA_VERSION, openChunkStore } from './db'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-enc-'))
  dirs.push(dir)
  return dir
}

function insertChunk(store: ReturnType<typeof openChunkStore>, text: string): string {
  const id = randomUUIDv7()
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: '/tmp/x.png',
    bytes: 10,
    text,
    capture_ms: 1,
  })
  return id
}

function indexSchemaVersion(dbPath: string): number {
  const db = new BunDatabase(dbPath, { readonly: true })
  const version =
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  db.close()
  return version
}

function setIndexSchemaVersion(dbPath: string, version: number): void {
  const db = new BunDatabase(dbPath)
  db.run(`PRAGMA user_version = ${version}`)
  db.close()
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        const until = Date.now() + 100
        while (Date.now() < until) {}
      }
    }
  }
})

describe('index DB schema versioning', () => {
  test('fresh DB records the migrated schema version', () => {
    const dbPath = join(freshDir(), 'index.db')

    const store = openChunkStore(dbPath)
    const vecEnabled = store.vecEnabled
    store.close()

    expect(indexSchemaVersion(dbPath)).toBe(vecEnabled ? CURRENT_INDEX_SCHEMA_VERSION : 2)
  })

  test('legacy schema versions migrate without losing existing chunks', () => {
    const dbPath = join(freshDir(), 'index.db')
    const store = openChunkStore(dbPath)
    const id = insertChunk(store, 'legacy schema note')
    store.close()
    setIndexSchemaVersion(dbPath, 1)

    const migrated = openChunkStore(dbPath)
    const vecEnabled = migrated.vecEnabled
    migrated.close()

    expect(indexSchemaVersion(dbPath)).toBe(vecEnabled ? CURRENT_INDEX_SCHEMA_VERSION : 2)
    const db = new BunDatabase(dbPath, { readonly: true })
    const row = db.query<{ text: string }, [string]>('SELECT text FROM chunks WHERE id = ?').get(id)
    db.close()
    expect(row?.text).toBe('legacy schema note')
  })

  test('future schema versions are rejected', () => {
    const dbPath = join(freshDir(), 'index.db')
    setIndexSchemaVersion(dbPath, CURRENT_INDEX_SCHEMA_VERSION + 1)

    expect(() => openChunkStore(dbPath)).toThrow(/newer than supported/)
  })
})
