// Integration tests for periodActivity and the recent_activity cursor against
// a real temp index DB: pagination must walk a busy multi-day range without
// duplicates or gaps, and union-of-pages must equal the unpaginated result.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openChunkStore } from '../../store/db'
import { decodePeriodActivityCursor, HyprmnesiaReadStore } from './index'
import type { PeriodSession } from './period'

const dirs: string[] = []

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-pa-'))
  dirs.push(dir)
  const dbPath = join(dir, 'index.db')
  const store = openChunkStore(dbPath)
  return { dbPath, store }
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

// Local midnight anchor so sessions land on deterministic local days.
function localMidnight(daysAgoFrom: number): number {
  const d = new Date(daysAgoFrom)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY = 86_400_000
const RANGE_START = localMidnight(1_750_000_000_000)

// Seven days, three well-separated sessions per day (gaps >> 30s), each
// session two screenshots 5s apart.
function seedSevenDays(store: ReturnType<typeof openChunkStore>): number {
  let inserted = 0
  for (let day = 0; day < 7; day++) {
    for (let sess = 0; sess < 3; sess++) {
      const base = RANGE_START + day * DAY + (9 + sess * 2) * 3_600_000
      for (let shot = 0; shot < 2; shot++) {
        store.insert({
          id: `d${day}-s${sess}-c${shot}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'screenshot',
          at: base + shot * 5_000,
          blob: '/tmp/x.png',
          bytes: 10,
          text: `day ${day} session ${sess} capture ${shot}`,
          capture_ms: 1,
          window: { app: `App${sess}`, title: `Doc ${day}` },
        })
        inserted++
      }
    }
  }
  return inserted
}

test('periodActivity: paginated union equals the unpaginated result, no duplicates', () => {
  const { dbPath, store } = freshStore()
  seedSevenDays(store)
  store.close()

  const read = new HyprmnesiaReadStore(dbPath)
  const from = RANGE_START
  const to = RANGE_START + 7 * DAY - 1
  const sources = ['screen', 'mic', 'system'] as const

  const all = read.periodActivity({ from, to, sources: [...sources], limit: 50 })
  expect(all.truncated).toBe(false)
  expect(all.next_cursor).toBeNull()
  expect(all.sessions).toHaveLength(21)
  expect(all.total_sessions).toBe(21)
  expect(all.days).toHaveLength(7)
  for (const day of all.days) expect(day.sessions).toBe(3)

  const paged: PeriodSession[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = read.periodActivity({
      from,
      to,
      sources: [...sources],
      limit: 4,
      cursor: decodePeriodActivityCursor(cursor ?? undefined),
    })
    paged.push(...page.sessions)
    cursor = page.next_cursor
    if (cursor) expect(page.truncated).toBe(true)
    pages++
    expect(pages).toBeLessThan(20)
  } while (cursor)

  expect(paged.map((s) => s.id)).toEqual(all.sessions.map((s) => s.id))
  expect(new Set(paged.map((s) => s.id)).size).toBe(21)
  read.close()
})

test('periodActivity: sessions carry day keys, durations, and recallable excerpt ids', () => {
  const { dbPath, store } = freshStore()
  seedSevenDays(store)
  store.close()

  const read = new HyprmnesiaReadStore(dbPath)
  const result = read.periodActivity({
    from: RANGE_START,
    to: RANGE_START + DAY - 1,
    sources: ['screen', 'mic', 'system'],
  })
  expect(result.sessions).toHaveLength(3)
  for (const session of result.sessions) {
    expect(session.date).toBe(result.days[0]!.date)
    // Two captures 5s apart: 5s gap + 5s tail floor.
    expect(session.estimated_active_ms).toBe(10_000)
    expect(session.excerpts.length).toBeGreaterThan(0)
    const recalled = read.recall(session.excerpts[0]!.chunk_id, false)
    expect(recalled.found).toBe(true)
  }
  expect(result.days[0]!.by_app.map((row) => row.key).sort()).toEqual(['App0', 'App1', 'App2'])
  read.close()
})

test('periodActivity: range over 31 days is rejected', () => {
  const { dbPath, store } = freshStore()
  store.close()
  const read = new HyprmnesiaReadStore(dbPath)
  expect(() =>
    read.periodActivity({
      from: RANGE_START,
      to: RANGE_START + 40 * DAY,
      sources: ['screen'],
    }),
  ).toThrow(/31 days/)
  read.close()
})

test('recentActivity: cursor pages older groups without loss or duplicates', () => {
  const { dbPath, store } = freshStore()
  seedSevenDays(store)
  store.close()

  const read = new HyprmnesiaReadStore(dbPath)
  const from = RANGE_START
  const to = RANGE_START + 7 * DAY - 1

  const all = read.recentActivity({
    from,
    to,
    sources: ['screen', 'mic', 'system'],
    limit: 100,
  })
  expect(all.truncated).toBe(false)
  expect(all.next_cursor).toBeNull()
  expect(all.groups).toHaveLength(21)

  const seen: string[] = []
  let beforeAt: number | undefined
  let truncatedSeen = false
  for (let i = 0; i < 20; i++) {
    const page = read.recentActivity({
      from,
      to,
      sources: ['screen', 'mic', 'system'],
      limit: 5,
      beforeAt,
    })
    // Pages return the newest remaining groups; collect chunk ids.
    seen.push(...page.groups.flatMap((g) => g.chunk_ids))
    if (!page.next_cursor) break
    truncatedSeen = truncatedSeen || page.truncated
    const decoded = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8')) as {
      before_at: number
    }
    beforeAt = decoded.before_at
  }
  expect(truncatedSeen).toBe(true)
  const allIds = all.groups.flatMap((g) => g.chunk_ids)
  expect(new Set(seen).size).toBe(seen.length)
  expect(seen.sort()).toEqual(allIds.sort())
  read.close()
})
