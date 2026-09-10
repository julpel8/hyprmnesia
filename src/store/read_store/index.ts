import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { type IndexDb, openReadIndexDb } from '../../store/index_db'
import { loadVecExtension, serializeVector } from '../../store/vec'
import { buildActivityGroups } from './activity'
import { encodeCursor } from './cursor'
import {
  buildFtsQuery,
  clampLimit,
  clampOffset,
  normalizeMode,
  normalizeSource,
  ReadStoreError,
} from './filters'
import {
  chunkSource,
  excerpt,
  iso,
  kindForSource,
  LOCAL_TIMEZONE,
  localIso,
  mimeForKind,
  resolveRowBlob,
  toSegment,
  toTimelineItem,
  windowFromRow,
} from './format'
import {
  PERIOD_DAY_ROW_CAP,
  type PeriodActivityFilters,
  type PeriodActivityResult,
  type PeriodDayRows,
  walkPeriodDays,
} from './period_walk'
import type {
  ChunkRow,
  QueryFilters,
  RecallResult,
  RecentActivityFilters,
  RecentActivityResult,
  SearchChunkRow,
  SearchResult,
  SearchSegmentRow,
  SearchVecRow,
  SegmentResult,
  SegmentRow,
  TimelineItem,
} from './types'

export { decodePeriodActivityCursor, decodeRecentActivityCursor } from './cursor'
export {
  clampLimit,
  clampOffset,
  normalizeSource,
  normalizeSources,
  parseTimestamp,
  ReadStoreError,
} from './filters'
export type {
  PeriodActivityFilters,
  PeriodActivityResult,
  PeriodDayRows,
} from './period_walk'
export type {
  QueryFilters,
  RecallResult,
  RecentActivityFilters,
  RecentActivityResult,
  SearchResult,
  SegmentResult,
  TimelineItem,
} from './types'

// k0 in the standard RRF formulation: the larger it is, the less rank position
// matters. 60 is the canonical default from Cormack et al. (TREC-2009) and
// matches what Vespa/Elastic ship. Exposed for tests.
export const RRF_K0 = 60

// Reciprocal Rank Fusion: score = Σ 1/(k0 + rank). Higher is better, so the
// returned `score` semantics differ from BM25 (lower-is-better) on purpose.
// Each input list is treated as ranked best-first (index 0 = best). The same
// result appearing in both lists has its contributions summed; ties are broken
// by the more recent `time` first.
export function rrfFuse(
  fts: SearchResult[],
  vec: SearchResult[],
  limit: number,
  offset: number,
): SearchResult[] {
  return rrfFuseMany([fts, vec], limit, offset)
}

// Same fusion over any number of ranked lists. Used to merge one list per
// machine: BM25 scores and vector distances are not comparable across
// databases, but ranks are.
export function rrfFuseMany(
  lists: SearchResult[][],
  limit: number,
  offset: number,
): SearchResult[] {
  const fused = new Map<string, { result: SearchResult; rrf: number; order: number }>()
  let counter = 0
  for (const list of lists) {
    list.forEach((result, index) => {
      const key = `${result.host ?? ''}:${result.type}:${result.id}`
      const contribution = 1 / (RRF_K0 + index + 1)
      const existing = fused.get(key)
      if (existing) existing.rrf += contribution
      else fused.set(key, { result, rrf: contribution, order: counter++ })
    })
  }
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf || b.result.time - a.result.time || a.order - b.order)
    .slice(offset, offset + limit)
    .map((entry) => ({ ...entry.result, score: entry.rrf }))
}

// Where one machine's index lives, and where the blob paths it stores are
// rooted. `hostDir` defaults to the directory holding the database, which is
// where a machine's published snapshot sits next to its `data/` tree; the local
// daemon passes it explicitly because its live database stays outside the
// shared folder.
export interface ReadStoreOptions {
  dbPath: string
  hostId?: string
  hostDir?: string
}

export class HyprmnesiaReadStore {
  private db: IndexDb
  // True when sqlite-vec loaded and the v3 vector tables exist. Vector search
  // silently falls back to FTS5 when false.
  readonly vecReady: boolean
  readonly dbPath: string
  readonly hostId: string
  readonly hostDir: string
  // SQL fragment restricting transcript segments to the primary engine's ones.
  // Another machine's snapshot may predate the `role` column, and naming a
  // column that does not exist is a query error rather than a null, so the
  // filter is decided per database when it is opened. A database without the
  // column only ever held primary segments anyway.
  private readonly primaryOnly: (alias: string) => string

  constructor(options: string | ReadStoreOptions) {
    const opts = typeof options === 'string' ? { dbPath: options } : options
    const dbPath = opts.dbPath
    this.dbPath = dbPath
    this.hostDir = opts.hostDir ?? dirname(dbPath)
    this.hostId = opts.hostId ?? basename(this.hostDir)
    if (!existsSync(dbPath)) {
      throw new ReadStoreError(`index database not found at ${dbPath}`)
    }
    try {
      this.db = openReadIndexDb(dbPath)
      this.db.run('PRAGMA query_only = ON')
      this.db.run('PRAGMA busy_timeout = 2000')
      const version =
        this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
      if (version < 2) {
        throw new ReadStoreError(
          `index database schema is v${version}; the read store requires v2 or newer`,
        )
      }
      this.vecReady = version >= 3 && loadVecExtension(this.db)
      const hasRole = this.db
        .query<{ name: string }, []>('PRAGMA table_info(transcript_segments)')
        .all()
        .some((column) => column.name === 'role')
      this.primaryOnly = hasRole ? (alias) => `${alias}.role = 'primary'` : () => '1 = 1'
    } catch (err) {
      if (err instanceof ReadStoreError) throw err
      throw new ReadStoreError(`failed to open read-only index database: ${String(err)}`)
    }
  }

  close(): void {
    this.db.close()
  }

  // Rows carry no notion of which machine they came from; the store that read
  // them does. Stamping here keeps every downstream helper — blob resolution,
  // `has_blob`, activity grouping — working on merged rows from several
  // machines without threading the context through each call.
  private stamp<T extends ChunkRow>(row: T): T {
    row.host = this.hostId
    row.host_dir = this.hostDir
    return row
  }

  search(query: string, filters: QueryFilters): SearchResult[] {
    return this.searchPage(query, filters, clampLimit(filters.limit), clampOffset(filters.offset))
  }

  // Public for the same reason as `timelinePage`: fusing N machines' rankings
  // needs `offset + limit` hits from each, above the cap `search` applies.
  searchPage(query: string, filters: QueryFilters, limit: number, offset: number): SearchResult[] {
    const mode = normalizeMode(filters.mode)
    const innerLimit = limit + offset
    const useVec = mode !== 'lexical' && this.vecReady && filters.queryVector !== undefined

    // semantic: vectors only, but fall back to FTS5 when the index/embedder
    // isn't ready so the tool never returns empty for a valid query.
    if (mode === 'semantic') {
      const results = useVec
        ? this.vectorResults(filters, innerLimit)
        : this.ftsResults(query, filters, innerLimit)
      return results.slice(offset, offset + limit)
    }

    const fts = this.ftsResults(query, filters, innerLimit)
    if (!useVec) return fts.slice(offset, offset + limit)

    // hybrid: fuse FTS5 (BM25) and vector rankings with Reciprocal Rank Fusion.
    const vec = this.vectorResults(filters, innerLimit)
    return rrfFuse(fts, vec, limit, offset)
  }

  private ftsResults(query: string, filters: QueryFilters, innerLimit: number): SearchResult[] {
    const fts = buildFtsQuery(query)
    const source = normalizeSource(filters.source)
    const params = {
      $query: fts,
      $from: filters.from ?? null,
      $to: filters.to ?? null,
      $kind: kindForSource(source) ?? null,
      $segment_source: source === 'screen' ? '__none__' : (source ?? null),
      $app: filters.app ? `%${filters.app}%` : null,
      $limit: innerLimit,
      $offset: 0,
    }

    const chunks =
      source === 'mic' || source === 'system'
        ? []
        : this.db
            .query<SearchChunkRow, typeof params>(
              `
              SELECT c.*,
                     snippet(chunks_fts, 0, '', '', '...', 24) AS snippet,
                     bm25(chunks_fts) AS score
              FROM chunks_fts
              JOIN chunks c ON c.rowid = chunks_fts.rowid
              WHERE chunks_fts MATCH $query
                AND ($from IS NULL OR c.at >= $from)
                AND ($to IS NULL OR c.at <= $to)
                AND ($kind IS NULL OR c.kind = $kind)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY score
              LIMIT $limit OFFSET $offset
            `,
            )
            .all(params)

    const segments =
      source === 'screen'
        ? []
        : this.db
            .query<SearchSegmentRow, typeof params>(
              `
              SELECT s.*,
                     c.window_app, c.window_title, c.window_url, c.window_pid,
                     snippet(transcript_segments_fts, 0, '', '', '...', 24) AS snippet,
                     bm25(transcript_segments_fts) AS score
              FROM transcript_segments_fts
              JOIN transcript_segments s ON s.rowid = transcript_segments_fts.rowid
              JOIN chunks c ON c.id = s.chunk_id
              WHERE transcript_segments_fts MATCH $query
                AND ($from IS NULL OR s.start_at >= $from)
                AND ($to IS NULL OR s.start_at <= $to)
                AND ($segment_source IS NULL OR s.source = $segment_source)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY score
              LIMIT $limit OFFSET $offset
            `,
            )
            .all(params)

    const out: SearchResult[] = [
      ...segments.map((row) =>
        this.segmentResult(row, excerpt(row.snippet || row.text), row.score),
      ),
      ...chunks.map((row) => this.chunkResult(row, excerpt(row.snippet || row.text), row.score)),
    ]
    return out.sort((a, b) => a.score - b.score || b.time - a.time)
  }

  private vectorResults(filters: QueryFilters, innerLimit: number): SearchResult[] {
    const vector = filters.queryVector
    if (!vector) return []
    const source = normalizeSource(filters.source)
    // KNN drops rows the post-filters reject, so over-fetch then trim.
    const k = Math.max(innerLimit * 5, 50)
    const params = {
      $qvec: serializeVector(vector),
      $k: k,
      $from: filters.from ?? null,
      $to: filters.to ?? null,
      $kind: kindForSource(source) ?? null,
      $segment_source: source === 'screen' ? '__none__' : (source ?? null),
      $app: filters.app ? `%${filters.app}%` : null,
    }

    const segments =
      source === 'screen'
        ? []
        : this.db
            .query<SearchSegmentRow & SearchVecRow, typeof params>(
              `
              SELECT s.*,
                     c.window_app, c.window_title, c.window_url, c.window_pid,
                     v.distance AS distance
              FROM transcript_segment_vec v
              JOIN transcript_segments s ON s.id = v.segment_id
              JOIN chunks c ON c.id = s.chunk_id
              WHERE v.embedding MATCH $qvec AND k = $k
                AND ($from IS NULL OR s.start_at >= $from)
                AND ($to IS NULL OR s.start_at <= $to)
                AND ($segment_source IS NULL OR s.source = $segment_source)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY v.distance
            `,
            )
            .all(params)

    const chunks =
      source === 'mic' || source === 'system'
        ? []
        : this.db
            .query<SearchChunkRow & SearchVecRow, typeof params>(
              `
              SELECT c.*, v.distance AS distance
              FROM chunk_vec v
              JOIN chunks c ON c.id = v.chunk_id
              WHERE v.embedding MATCH $qvec AND k = $k
                AND ($from IS NULL OR c.at >= $from)
                AND ($to IS NULL OR c.at <= $to)
                AND ($kind IS NULL OR c.kind = $kind)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY v.distance
            `,
            )
            .all(params)

    const out: SearchResult[] = [
      ...segments.map((row) => this.segmentResult(row, excerpt(row.text), row.distance)),
      ...chunks.map((row) => this.chunkResult(row, excerpt(row.text), row.distance)),
    ]
    // distance: lower is closer.
    return out.sort((a, b) => a.score - b.score || b.time - a.time)
  }

  private segmentResult(row: SearchSegmentRow, snippet: string, score: number): SearchResult {
    return {
      id: row.id,
      type: 'transcript_segment',
      source: row.source,
      time: row.start_at,
      timezone: LOCAL_TIMEZONE,
      local_time: localIso(row.start_at)!,
      utc_time: iso(row.start_at)!,
      iso_time: iso(row.start_at)!,
      end_time: row.end_at,
      local_end_time: localIso(row.end_at),
      utc_end_time: iso(row.end_at),
      iso_end_time: iso(row.end_at),
      snippet,
      score,
      chunk_id: row.chunk_id,
      window: windowFromRow(row),
      host: this.hostId,
    }
  }

  private chunkResult(row: SearchChunkRow, snippet: string, score: number): SearchResult {
    return {
      id: row.id,
      type: 'chunk',
      source: chunkSource(row.kind),
      time: row.at,
      timezone: LOCAL_TIMEZONE,
      local_time: localIso(row.at)!,
      utc_time: iso(row.at)!,
      iso_time: iso(row.at)!,
      end_time: row.end_at,
      local_end_time: localIso(row.end_at),
      utc_end_time: iso(row.end_at),
      iso_end_time: iso(row.end_at),
      snippet,
      score,
      chunk_id: row.id,
      window: windowFromRow(row),
      host: this.hostId,
    }
  }

  timeline(filters: QueryFilters & { from: number; to: number }): TimelineItem[] {
    return this.timelinePage(filters, clampLimit(filters.limit), clampOffset(filters.offset))
  }

  // Public so the federated reader can pull more than one public page out of a
  // machine: merging N machines' lists needs `offset + limit` rows from each,
  // which is above the cap `timeline` applies to a caller-supplied limit.
  timelinePage(
    filters: QueryFilters & { from: number; to: number },
    limit: number,
    offset: number,
  ): TimelineItem[] {
    const source = normalizeSource(filters.source)
    const params = {
      $from: filters.from,
      $to: filters.to,
      $kind: kindForSource(source) ?? null,
      $app: filters.app ? `%${filters.app}%` : null,
      $include_empty: filters.includeEmpty ? 1 : 0,
      $limit: limit,
      $offset: offset,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT c.*,
               (SELECT COUNT(*) FROM transcript_segments s
                 WHERE s.chunk_id = c.id AND ${this.primaryOnly('s')}) AS segment_count
        FROM chunks c
        WHERE c.at >= $from
          AND c.at <= $to
          AND ($kind IS NULL OR c.kind = $kind)
          AND ($app IS NULL OR c.window_app LIKE $app)
          AND (
            $include_empty = 1
            OR COALESCE(c.text, '') <> ''
            OR EXISTS (SELECT 1 FROM transcript_segments sx
                       WHERE sx.chunk_id = c.id AND ${this.primaryOnly('sx')})
          )
        ORDER BY at ASC
        LIMIT $limit OFFSET $offset
      `,
      )
      .all(params)
    return rows.map((row) => toTimelineItem(this.stamp(row)))
  }

  recentActivity(filters: RecentActivityFilters): RecentActivityResult {
    const limit = clampLimit(filters.limit, 50)
    const kinds = new Set(filters.sources.map(kindForSource).filter(Boolean))
    const rawLimit = Math.min(500, Math.max(100, limit * 12))
    const params = {
      $from: filters.from,
      $to: filters.to,
      $before_at: filters.beforeAt ?? null,
      $include_screen: kinds.has('screenshot') ? 1 : 0,
      $include_mic: kinds.has('audio_mic') ? 1 : 0,
      $include_system: kinds.has('audio_system') ? 1 : 0,
      $app: filters.app ? `%${filters.app}%` : null,
      $include_empty: filters.includeEmpty ? 1 : 0,
      $limit: rawLimit,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT c.*,
               (SELECT COUNT(*) FROM transcript_segments s
                 WHERE s.chunk_id = c.id AND ${this.primaryOnly('s')}) AS segment_count
        FROM chunks c
        WHERE c.at >= $from
          AND c.at <= $to
          AND ($before_at IS NULL OR c.at < $before_at)
          AND (
            ($include_screen = 1 AND c.kind = 'screenshot')
            OR ($include_mic = 1 AND c.kind = 'audio_mic')
            OR ($include_system = 1 AND c.kind = 'audio_system')
          )
          AND ($app IS NULL OR c.window_app LIKE $app)
          AND (
            $include_empty = 1
            OR COALESCE(c.text, '') <> ''
            OR EXISTS (SELECT 1 FROM transcript_segments sx
                       WHERE sx.chunk_id = c.id AND ${this.primaryOnly('sx')})
          )
        ORDER BY c.at DESC
        LIMIT $limit
      `,
      )
      .all(params)
      .map((row) => this.stamp(row))
      .sort((a, b) => a.at - b.at)

    const groups = buildActivityGroups(rows)
    const page = groups.slice(Math.max(0, groups.length - limit))
    // Older data exists when the raw fetch filled up (rows below the window
    // were cut off) or grouping produced more groups than the page holds. The
    // cursor is the oldest row belonging to a returned group, so the next page
    // re-derives everything older than the reported window — including groups
    // dropped from this page; a group spanning the boundary shows up split
    // across pages (chunk ids stay stable).
    const truncated = rows.length === rawLimit || groups.length > limit
    const pageChunkIds = new Set(page.flatMap((group) => group.chunk_ids))
    const pageRowAts = rows.filter((row) => pageChunkIds.has(row.id)).map((row) => row.at)
    const next_cursor =
      truncated && pageRowAts.length > 0
        ? encodeCursor({ v: 1, t: 'ra', before_at: Math.min(...pageRowAts) })
        : null
    return { groups: page, truncated, next_cursor }
  }

  periodActivity(filters: PeriodActivityFilters): PeriodActivityResult {
    return walkPeriodDays(filters, (from, to) => this.periodDayRows(from, to, filters))
  }

  // Public so the federated reader can merge one day's rows across machines
  // before turning them into sessions.
  periodDayRows(
    from: number,
    to: number,
    filters: Pick<PeriodActivityFilters, 'sources' | 'app'>,
  ): PeriodDayRows {
    const kinds = new Set(filters.sources.map(kindForSource).filter(Boolean))
    const params = {
      $from: from,
      $to: to,
      $include_screen: kinds.has('screenshot') ? 1 : 0,
      $include_mic: kinds.has('audio_mic') ? 1 : 0,
      $include_system: kinds.has('audio_system') ? 1 : 0,
      $app: filters.app ? `%${filters.app}%` : null,
      $limit: PERIOD_DAY_ROW_CAP + 1,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT c.*,
               (SELECT COUNT(*) FROM transcript_segments s
                 WHERE s.chunk_id = c.id AND ${this.primaryOnly('s')}) AS segment_count
        FROM chunks c
        WHERE c.at >= $from
          AND c.at <= $to
          AND (
            ($include_screen = 1 AND c.kind = 'screenshot')
            OR ($include_mic = 1 AND c.kind = 'audio_mic')
            OR ($include_system = 1 AND c.kind = 'audio_system')
          )
          AND ($app IS NULL OR c.window_app LIKE $app)
          AND (
            COALESCE(c.text, '') <> ''
            OR EXISTS (SELECT 1 FROM transcript_segments sx
                       WHERE sx.chunk_id = c.id AND ${this.primaryOnly('sx')})
          )
        ORDER BY c.at ASC
        LIMIT $limit
      `,
      )
      .all(params)
      .map((row) => this.stamp(row))
    const capped = rows.length > PERIOD_DAY_ROW_CAP
    if (capped) rows.pop()

    const segmentParams = { $from: from, $to: to, $limit: params.$limit }
    const segments = this.db
      .query<SegmentRow, typeof segmentParams>(
        `
        SELECT *
        FROM transcript_segments
        WHERE start_at >= $from
          AND start_at <= $to
          AND ${this.primaryOnly('transcript_segments')}
          AND COALESCE(text, '') <> ''
        ORDER BY start_at ASC
        LIMIT $limit
      `,
      )
      .all(segmentParams)
    if (segments.length > PERIOD_DAY_ROW_CAP) segments.pop()

    return { rows, segments, capped }
  }

  recall(id: string, includeBlob: boolean): RecallResult {
    const row = this.db.query<ChunkRow, [string]>('SELECT * FROM chunks WHERE id = ?').get(id)
    if (!row) return { found: false }
    this.stamp(row)
    const segments = this.db
      .query<SegmentRow, [string]>(
        `
        SELECT *
        FROM transcript_segments
        WHERE chunk_id = ?
        ORDER BY start_at ASC
      `,
      )
      .all(id)
      .map(toSegment)
    // Both transcripts are returned so a caller can compare them, but the count
    // that describes the chunk stays the number of primary segments.
    const primaryCount = segments.filter((segment) => segment.role === 'primary').length
    const chunk = {
      ...toTimelineItem(row, primaryCount),
      text: row.text ?? '',
      ocr_engine: row.ocr_engine,
      audio_engine: row.audio_engine,
      audio_device: row.audio_device,
      audio_sample_rate: row.audio_sample_rate,
      audio_chunk_ms: row.audio_chunk_ms,
      audio_rms_db: row.audio_rms_db,
      audio_peak_db: row.audio_peak_db,
      segments,
      ...(includeBlob ? this.blobFields(row) : {}),
    }
    return { found: true, chunk }
  }

  // Blob fields for `recall(include_blob)`: the on-disk path and its mime type.
  private blobFields(row: ChunkRow): { blob_path: string; mime_type: string } {
    return { blob_path: resolveRowBlob(row), mime_type: mimeForKind(row.kind, row.blob) }
  }

  getTranscriptSegment(id: string, includeChunk: boolean): SegmentResult {
    const row = this.db
      .query<SegmentRow, [string]>('SELECT * FROM transcript_segments WHERE id = ?')
      .get(id)
    if (!row) return { found: false }
    const segment = toSegment(row)
    if (!includeChunk) return { found: true, segment }
    const chunk = this.db
      .query<ChunkRow, [string]>('SELECT * FROM chunks WHERE id = ?')
      .get(row.chunk_id)
    return {
      found: true,
      segment: { ...segment, ...(chunk ? { chunk: toTimelineItem(this.stamp(chunk)) } : {}) },
    }
  }
}
