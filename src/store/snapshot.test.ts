import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from './db'
import { HyprmnesiaReadStore } from './read_store'
import { publishSnapshot } from './snapshot'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-snap-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (attempt === 9) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
})

test('the snapshot carries the live rows and has no WAL sidecar', () => {
  const dir = freshDir()
  const live = join(dir, 'index.db')
  const store = openChunkStore(live)
  const id = randomUUIDv7()
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: join('data', 'a.png'),
    bytes: 1,
    text: 'snapshot me',
    capture_ms: 1,
  })

  const dest = join(freshDir(), 'rpi5', 'index.db')
  publishSnapshot(live, dest)
  store.close()

  expect(existsSync(`${dest}-wal`)).toBe(false)
  expect(existsSync(`${dest}.tmp`)).toBe(false)
  const read = new HyprmnesiaReadStore(dest)
  try {
    expect(read.search('snapshot', { mode: 'lexical' }).map((r) => r.id)).toEqual([id])
  } finally {
    read.close()
  }
})

test('publishing again replaces the previous snapshot in place', () => {
  const dir = freshDir()
  const live = join(dir, 'index.db')
  const store = openChunkStore(live)
  const dest = join(freshDir(), 'index.db')
  publishSnapshot(live, dest)

  const id = randomUUIDv7()
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: join('data', 'b.png'),
    bytes: 1,
    text: 'second pass',
    capture_ms: 1,
  })
  publishSnapshot(live, dest)
  store.close()

  const read = new HyprmnesiaReadStore(dest)
  try {
    expect(read.search('second', { mode: 'lexical' }).map((r) => r.id)).toEqual([id])
  } finally {
    read.close()
  }
})

test('a stale temporary file from a crashed run does not block the next publish', () => {
  const dir = freshDir()
  const live = join(dir, 'index.db')
  openChunkStore(live).close()
  const dest = join(freshDir(), 'index.db')
  writeFileSync(`${dest}.tmp`, 'garbage from a previous run')

  publishSnapshot(live, dest)

  expect(existsSync(dest)).toBe(true)
  expect(existsSync(`${dest}.tmp`)).toBe(false)
})
