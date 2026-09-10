import { expect, test } from 'bun:test'
import {
  decodePeriodActivityCursor,
  decodeRecentActivityCursor,
  encodeCursor,
  type PeriodActivityCursor,
  type RecentActivityCursor,
} from './cursor'

test('recent_activity cursor round-trips', () => {
  const cursor: RecentActivityCursor = { v: 1, t: 'ra', before_at: 1_700_000_000_000 }
  expect(decodeRecentActivityCursor(encodeCursor(cursor))).toEqual(cursor)
})

test('period_activity cursor round-trips', () => {
  const cursor: PeriodActivityCursor = { v: 1, t: 'pa', day: '2026-06-08', after: 123 }
  expect(decodePeriodActivityCursor(encodeCursor(cursor))).toEqual(cursor)
})

test('absent cursors decode to undefined', () => {
  expect(decodeRecentActivityCursor(undefined)).toBeUndefined()
  expect(decodeRecentActivityCursor(null)).toBeUndefined()
  expect(decodePeriodActivityCursor('')).toBeUndefined()
})

test('garbage cursors are rejected', () => {
  expect(() => decodeRecentActivityCursor('not-base64-json')).toThrow(/invalid cursor/)
  expect(() => decodeRecentActivityCursor(42)).toThrow(/invalid cursor/)
  expect(() =>
    decodeRecentActivityCursor(Buffer.from('"just a string"').toString('base64url')),
  ).toThrow(/invalid cursor/)
  expect(() =>
    decodePeriodActivityCursor(
      Buffer.from('{"v":1,"t":"pa","day":"nope","after":1}').toString('base64url'),
    ),
  ).toThrow(/invalid cursor/)
})

test('cursors are bound to their tool', () => {
  const ra = encodeCursor({ v: 1, t: 'ra', before_at: 1 })
  const pa = encodeCursor({ v: 1, t: 'pa', day: '2026-06-08', after: 1 })
  expect(() => decodeRecentActivityCursor(pa)).toThrow(/invalid cursor/)
  expect(() => decodePeriodActivityCursor(ra)).toThrow(/invalid cursor/)
})

test('unknown cursor versions are rejected', () => {
  const future = Buffer.from('{"v":2,"t":"ra","before_at":1}').toString('base64url')
  expect(() => decodeRecentActivityCursor(future)).toThrow(/invalid cursor/)
})
