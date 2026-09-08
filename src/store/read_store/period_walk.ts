import { encodeCursor, type PeriodActivityCursor } from './cursor'
import { clampLimit, ReadStoreError } from './filters'
import { LOCAL_TIMEZONE } from './format'
import {
  buildDayAggregates,
  buildPeriodSessions,
  localDayKey,
  type PeriodDayAggregates,
  type PeriodSession,
} from './period'
import type { ChunkRow, SegmentRow, SourceFilter } from './types'

export interface PeriodActivityFilters {
  from: number
  to: number
  sources: SourceFilter[]
  app?: string
  limit?: number
  cursor?: PeriodActivityCursor
}

export interface PeriodActivityResult {
  sessions: PeriodSession[]
  days: PeriodDayAggregates[]
  timezone: string
  truncated: boolean
  next_cursor: string | null
  total_sessions?: number
}

export interface PeriodDayRows {
  rows: ChunkRow[]
  segments: SegmentRow[]
  capped: boolean
}

// Hard cap on rows fetched per local day; busy days beyond this report
// `truncated` instead of unbounded memory use.
export const PERIOD_DAY_ROW_CAP = 5000
const PERIOD_MAX_RANGE_DAYS = 31

// Walks the local-timezone calendar days of [from, to] and turns each day's raw
// rows into sessions and aggregates.
//
// `fetchDay` is the only part that touches a database, which is what lets the
// federated reader hand over rows merged from several machines: sessions must be
// built once over the merged rows, never by adding up per-machine aggregates.
export function walkPeriodDays(
  filters: PeriodActivityFilters,
  fetchDay: (from: number, to: number) => PeriodDayRows,
): PeriodActivityResult {
  if (filters.to < filters.from) {
    throw new ReadStoreError('to must be greater than or equal to from')
  }
  const rangeDays = (filters.to - filters.from) / 86_400_000 // approximate; guards pathological ranges
  if (rangeDays > PERIOD_MAX_RANGE_DAYS) {
    throw new ReadStoreError(
      `period_activity range must be at most ${PERIOD_MAX_RANGE_DAYS} days; paginate with from/to instead`,
    )
  }
  const limit = clampLimit(filters.limit, 20)
  const cursor = filters.cursor

  const sessions: PeriodSession[] = []
  const days: PeriodDayAggregates[] = []
  let rowCapHit = false
  let next_cursor: string | null = null

  let dayStartMs = new Date(filters.from).setHours(0, 0, 0, 0)
  while (dayStartMs <= filters.to && next_cursor === null) {
    const dayStart = new Date(dayStartMs)
    const dayEndMs =
      new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1).getTime() - 1
    const dayKey = localDayKey(Math.max(dayStartMs, filters.from))
    const nextDayMs = dayEndMs + 1
    if (cursor && dayKey < cursor.day) {
      dayStartMs = nextDayMs
      continue
    }

    const from = Math.max(dayStartMs, filters.from)
    const to = Math.min(dayEndMs, filters.to)
    const { rows, segments, capped } = fetchDay(from, to)
    if (capped) rowCapHit = true

    const segmentsByChunk = new Map<string, SegmentRow[]>()
    for (const segment of segments) {
      const list = segmentsByChunk.get(segment.chunk_id)
      if (list) list.push(segment)
      else segmentsByChunk.set(segment.chunk_id, [segment])
    }

    const daySessions = buildPeriodSessions(rows, segmentsByChunk)
    days.push(buildDayAggregates(dayKey, daySessions))

    const pending =
      cursor && dayKey === cursor.day
        ? daySessions.filter((session) => session.start_at > cursor.after)
        : daySessions
    for (const session of pending) {
      if (sessions.length >= limit) {
        next_cursor = encodeCursor({
          v: 1,
          t: 'pa',
          day: dayKey,
          after: sessions[sessions.length - 1]!.start_at,
        })
        break
      }
      sessions.push(session)
    }

    dayStartMs = nextDayMs
  }

  const truncated = next_cursor !== null || rowCapHit
  const result: PeriodActivityResult = {
    sessions,
    days,
    timezone: LOCAL_TIMEZONE,
    truncated,
    next_cursor,
  }
  // Cheap total: only when this single call scanned the whole range.
  if (!cursor && !truncated) result.total_sessions = sessions.length
  return result
}
