import { ReadStoreError } from './filters'

// Opaque pagination cursors: base64url(JSON). `v` is bumped on any layout
// change; `t` binds a cursor to its tool so one tool's cursor cannot be
// replayed against another.
export interface RecentActivityCursor {
  v: 1
  t: 'ra'
  // Page boundary: only chunks with `at` strictly below this are considered.
  before_at: number
}

export interface PeriodActivityCursor {
  v: 1
  t: 'pa'
  // Local-timezone day (YYYY-MM-DD) to resume from.
  day: string
  // Sessions in `day` with start_at <= after were already emitted.
  after: number
}

export function encodeCursor(cursor: RecentActivityCursor | PeriodActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ReadStoreError('invalid cursor')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ReadStoreError('invalid cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReadStoreError('invalid cursor')
  }
  return parsed as Record<string, unknown>
}

export function decodeRecentActivityCursor(raw: unknown): RecentActivityCursor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const cursor = decodeRaw(raw)
  if (cursor.v !== 1 || cursor.t !== 'ra' || typeof cursor.before_at !== 'number') {
    throw new ReadStoreError('invalid cursor')
  }
  return { v: 1, t: 'ra', before_at: cursor.before_at }
}

export function decodePeriodActivityCursor(raw: unknown): PeriodActivityCursor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const cursor = decodeRaw(raw)
  if (
    cursor.v !== 1 ||
    cursor.t !== 'pa' ||
    typeof cursor.after !== 'number' ||
    typeof cursor.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(cursor.day)
  ) {
    throw new ReadStoreError('invalid cursor')
  }
  return { v: 1, t: 'pa', day: cursor.day, after: cursor.after }
}
