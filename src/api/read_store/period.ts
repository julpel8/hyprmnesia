// Deterministic multi-day activity sessions for the period_activity route
// (#86). Sessions reuse the recent_activity grouping; this module adds active
// duration estimation, representative excerpts, observable project context,
// and per-day aggregates. No semantic classification anywhere.

import { pad } from '../../util/format'
import { buildActivityGroups } from './activity'
import { excerpt, iso, LOCAL_TIMEZONE, localIso, textPresent } from './format'
import { domainFromUrl, type ProjectContext, parseProjectContext } from './project'
import type { ActivityGroup, ChunkRow, SegmentRow, SourceFilter, WindowPayload } from './types'

interface PeriodExcerpt {
  kind: 'ocr' | 'transcript'
  // Chunk id for OCR excerpts, transcript segment id for transcript excerpts —
  // both resolvable via the recall / get_transcript_segment tools.
  id: string
  chunk_id: string
  at: number
  text: string
}

export interface PeriodSession {
  id: string
  date: string
  start_at: number
  end_at: number
  timezone: string
  local_start_at: string
  utc_start_at: string
  local_end_at: string
  utc_end_at: string
  duration_ms: number
  estimated_active_ms: number
  window: WindowPayload
  app: string | null
  url: string | null
  domain: string | null
  project: ProjectContext | null
  sources: SourceFilter[]
  counts: ActivityGroup['counts']
  excerpts: PeriodExcerpt[]
}

interface PeriodAggregateRow {
  key: string
  sessions: number
  estimated_active_ms: number
}

export interface PeriodDayAggregates {
  date: string
  sessions: number
  estimated_active_ms: number
  by_app: PeriodAggregateRow[]
  by_project: PeriodAggregateRow[]
  by_domain: PeriodAggregateRow[]
  by_source: PeriodAggregateRow[]
}

// Local-timezone calendar day of a timestamp, as YYYY-MM-DD.
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Capture cadence is one screenshot every few seconds and audio chunks of a
// few seconds; a gap above 30 s between consecutive captures means the user
// was not observed, so it does not count as active time. The last item has no
// successor: count its own span, floored at 5 s (instantaneous screenshots)
// and capped at the same 30 s.
const ACTIVE_GAP_CAP_MS = 30_000
const ACTIVE_TAIL_FLOOR_MS = 5_000

export function estimatedActiveMs(items: Array<{ start: number; end: number }>): number {
  if (items.length === 0) return 0
  const sorted = [...items].sort((a, b) => a.start - b.start)
  let total = 0
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!
    const next = sorted[i + 1]!
    total += Math.min(Math.max(0, next.start - cur.start), ACTIVE_GAP_CAP_MS)
  }
  const last = sorted[sorted.length - 1]!
  total += Math.min(Math.max(last.end - last.start, ACTIVE_TAIL_FLOOR_MS), ACTIVE_GAP_CAP_MS)
  return total
}

const MAX_EXCERPTS = 3
const EXCERPT_MAX_CHARS = 240

function sessionExcerpts(
  group: ActivityGroup,
  rowsById: Map<string, ChunkRow>,
  segmentsByChunk: Map<string, SegmentRow[]>,
): PeriodExcerpt[] {
  const out: PeriodExcerpt[] = []
  for (const chunkId of group.chunk_ids_by_source.screen) {
    const row = rowsById.get(chunkId)
    if (row && textPresent(row.text)) {
      out.push({
        kind: 'ocr',
        id: row.id,
        chunk_id: row.id,
        at: row.at,
        text: excerpt(row.text, EXCERPT_MAX_CHARS),
      })
      break
    }
  }
  const segments: SegmentRow[] = []
  for (const chunkId of group.chunk_ids) {
    for (const segment of segmentsByChunk.get(chunkId) ?? []) {
      if (textPresent(segment.text)) segments.push(segment)
    }
  }
  segments.sort((a, b) => b.text.length - a.text.length || a.start_at - b.start_at)
  for (const segment of segments.slice(0, MAX_EXCERPTS - out.length)) {
    out.push({
      kind: 'transcript',
      id: segment.id,
      chunk_id: segment.chunk_id,
      at: segment.start_at,
      text: excerpt(segment.text, EXCERPT_MAX_CHARS),
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

export function buildPeriodSessions(
  rows: ChunkRow[],
  segmentsByChunk: Map<string, SegmentRow[]>,
): PeriodSession[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  return buildActivityGroups(rows).map((group) => {
    const items = group.chunk_ids
      .map((id) => rowsById.get(id))
      .filter((row): row is ChunkRow => Boolean(row))
      .map((row) => ({ start: row.start_at ?? row.at, end: row.end_at ?? row.at }))
    const url = group.window.url
    return {
      id: group.id,
      date: localDayKey(group.start_at),
      start_at: group.start_at,
      end_at: group.end_at,
      timezone: LOCAL_TIMEZONE,
      local_start_at: localIso(group.start_at)!,
      utc_start_at: iso(group.start_at)!,
      local_end_at: localIso(group.end_at)!,
      utc_end_at: iso(group.end_at)!,
      duration_ms: group.duration_ms,
      estimated_active_ms: estimatedActiveMs(items),
      window: group.window,
      app: group.window.app,
      url,
      domain: domainFromUrl(url),
      project: parseProjectContext(group.window.title),
      sources: group.sources,
      counts: group.counts,
      excerpts: sessionExcerpts(group, rowsById, segmentsByChunk),
    }
  })
}

function projectKey(project: ProjectContext | null): string | null {
  if (!project) return null
  if (project.repo) return project.branch ? `${project.repo} [${project.branch}]` : project.repo
  if (project.ssh_host) return `ssh:${project.ssh_host}`
  return null
}

function aggregate(
  sessions: PeriodSession[],
  keysOf: (session: PeriodSession) => Array<string | null>,
): PeriodAggregateRow[] {
  const rows = new Map<string, PeriodAggregateRow>()
  for (const session of sessions) {
    for (const key of keysOf(session)) {
      if (!key) continue
      const row = rows.get(key) ?? { key, sessions: 0, estimated_active_ms: 0 }
      row.sessions += 1
      row.estimated_active_ms += session.estimated_active_ms
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.estimated_active_ms - a.estimated_active_ms || a.key.localeCompare(b.key),
  )
}

export function buildDayAggregates(date: string, sessions: PeriodSession[]): PeriodDayAggregates {
  return {
    date,
    sessions: sessions.length,
    estimated_active_ms: sessions.reduce((sum, s) => sum + s.estimated_active_ms, 0),
    by_app: aggregate(sessions, (s) => [s.app]),
    by_project: aggregate(sessions, (s) => [projectKey(s.project)]),
    by_domain: aggregate(sessions, (s) => [s.domain]),
    // A multi-source session attributes its full active time to each of its
    // sources; by_source rows therefore overlap and do not sum to the total.
    by_source: aggregate(sessions, (s) => s.sources),
  }
}
