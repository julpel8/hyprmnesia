// The federated reader answers as if every machine's index were one database.
// The risks it carries are merge-order bugs (a page silently missing another
// machine's rows) and blob paths resolved against the wrong machine, so the
// tests below build two real databases and assert both.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from '../../store/db'
import type { HostSource } from '../../store/hosts'
import { FederatedReadStore } from './federated'

const dirs: string[] = []
const T = Date.UTC(2025, 0, 2, 12, 0, 0)

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-fed-'))
  dirs.push(dir)
  return dir
}

// One machine's slice of the shared tree: an index plus a `data/` tree of blobs.
function seedHost(
  root: string,
  hostId: string,
  rows: Array<{ id: string; at: number; text: string; blobName?: string }>,
): HostSource {
  const dir = join(root, hostId)
  mkdirSync(join(dir, 'data'), { recursive: true })
  const dbPath = join(dir, 'index.db')
  const store = openChunkStore(dbPath)
  for (const row of rows) {
    const rel = join('data', row.blobName ?? `${row.id}.png`)
    if (row.blobName !== undefined) writeFileSync(join(dir, rel), 'x')
    store.insert({
      id: row.id,
      kind: 'screenshot',
      at: row.at,
      blob: rel,
      bytes: row.blobName === undefined ? 0 : 1,
      text: row.text,
      capture_ms: 1,
    })
  }
  store.close()
  return { hostId, dir, dbPath, isLocal: hostId === 'rpi5' }
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

function twoHosts() {
  const root = freshRoot()
  const a = randomUUIDv7()
  const b = randomUUIDv7()
  const c = randomUUIDv7()
  const rpi5 = seedHost(root, 'rpi5', [
    { id: a, at: T, text: 'invoice from the pi', blobName: 'a.png' },
    { id: c, at: T + 4_000, text: 'later on the pi', blobName: 'c.png' },
  ])
  const dell = seedHost(root, 'dell', [
    { id: b, at: T + 2_000, text: 'invoice from the dell', blobName: 'b.png' },
  ])
  return { root, ids: { a, b, c }, hosts: [rpi5, dell] }
}

test('timeline interleaves both machines in time order and tags each item', () => {
  const { ids, hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    const items = read.timeline({ from: T - 1, to: T + 10_000 })
    expect(items.map((i) => i.id)).toEqual([ids.a, ids.b, ids.c])
    expect(items.map((i) => i.host)).toEqual(['rpi5', 'dell', 'rpi5'])
  } finally {
    read.close()
  }
})

test('timeline honours limit and offset across the merged order', () => {
  const { ids, hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    expect(read.timeline({ from: T - 1, to: T + 10_000, limit: 2 }).map((i) => i.id)).toEqual([
      ids.a,
      ids.b,
    ])
    expect(
      read.timeline({ from: T - 1, to: T + 10_000, limit: 2, offset: 1 }).map((i) => i.id),
    ).toEqual([ids.b, ids.c])
  } finally {
    read.close()
  }
})

test('search returns hits from every machine', () => {
  const { ids, hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    const results = read.search('invoice', { mode: 'lexical' })
    expect(results.map((r) => r.id).sort()).toEqual([ids.a, ids.b].sort())
    expect(new Set(results.map((r) => r.host))).toEqual(new Set(['rpi5', 'dell']))
  } finally {
    read.close()
  }
})

test('recall finds a chunk on any machine and resolves its blob against that machine', () => {
  const { root, ids, hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    const recalled = read.recall(ids.b, true)
    expect(recalled.found).toBe(true)
    expect(recalled.chunk?.host).toBe('dell')
    expect(recalled.chunk?.blob_path).toBe(join(root, 'dell', 'data', 'b.png'))
    expect(recalled.chunk?.has_blob).toBe(true)
  } finally {
    read.close()
  }
})

test('recall on an unknown id is not found rather than an error', () => {
  const { hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    expect(read.recall(randomUUIDv7(), false).found).toBe(false)
  } finally {
    read.close()
  }
})

test('an unreadable machine is skipped, not fatal', () => {
  const { ids, hosts } = twoHosts()
  const broken: HostSource = {
    hostId: 'macbook',
    dir: join(freshRoot(), 'macbook'),
    dbPath: join(freshRoot(), 'macbook', 'index.db'),
    isLocal: false,
  }
  const warnings: string[] = []
  const read = new FederatedReadStore({
    hosts: [...hosts, broken],
    onWarning: (message) => warnings.push(message),
  })
  try {
    expect(read.skipped).toEqual(['macbook'])
    expect(warnings).toHaveLength(1)
    expect(read.timeline({ from: T - 1, to: T + 10_000 }).map((i) => i.id)).toEqual([
      ids.a,
      ids.b,
      ids.c,
    ])
  } finally {
    read.close()
  }
})

test('period activity builds sessions over the merged rows, not per-machine totals', () => {
  const { hosts } = twoHosts()
  const read = new FederatedReadStore({ hosts })
  try {
    const result = read.periodActivity({ from: T - 60_000, to: T + 60_000, sources: ['screen'] })
    const chunks = result.sessions.reduce((total, s) => total + s.counts.chunks, 0)
    expect(chunks).toBe(3)
  } finally {
    read.close()
  }
})
