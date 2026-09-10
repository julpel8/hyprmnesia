import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseTimestamp, ReadStoreError } from '../api/read_store'
import {
  chunkSource,
  iso,
  LOCAL_TIMEZONE,
  localIso,
  mimeForKind,
  resolveRowBlob,
  windowFromRow,
} from '../api/read_store/format'
import type { ChunkRow, SegmentRow, WindowPayload } from '../api/read_store/types'
import { cachedHostSources } from '../store/hosts'
import { type IndexDb, openReadIndexDb } from '../store/index_db'
import { expandHome } from '../util/paths'

// How far before a replay range a screenshot may sit and still be shown as the
// opening frame. Screen capture runs every few seconds by default, so a minute
// covers ordinary gaps without reaching into an earlier session.
const PRECEDING_SCREENSHOT_MAX_AGE_MS = 60_000

export interface ReplayChunk {
  id: string
  kind: ChunkRow['kind']
  source: 'screen' | 'mic' | 'system'
  at: number
  local_at: string
  utc_at: string
  start_at: number
  local_start_at: string
  utc_start_at: string
  end_at: number | null
  local_end_at: string | null
  utc_end_at: string | null
  offset_start_ms: number
  offset_end_ms: number | null
  blob_start_offset_ms: number
  duration_ms: number | null
  bytes: number
  has_blob: boolean
  mime_type: string
  text: string
  window: WindowPayload
  audio?: {
    rms_db: number | null
    peak_db: number | null
    engine: string | null
    device: string | null
  }
  blob_url?: string | null
}

export interface ReplaySegment {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  local_start_at: string
  utc_start_at: string
  end_at: number
  local_end_at: string
  utc_end_at: string
  offset_start_ms: number
  offset_end_ms: number
  text: string
  engine: string
  transcribe_ms: number
}

export interface ReplayManifest {
  from: number
  to: number
  duration_ms: number
  timezone: string
  local_from: string
  utc_from: string
  local_to: string
  utc_to: string
  screenshots: ReplayChunk[]
  audio: {
    mic: ReplayChunk[]
    system: ReplayChunk[]
  }
  segments: ReplaySegment[]
}

export interface ReplayBounds {
  from: number | null
  to: number | null
  timezone: string
  local_from: string | null
  utc_from: string | null
  local_to: string | null
  utc_to: string | null
}

export interface ReplayBlobRef {
  id: string
  path: string
  mime_type: string
  bytes: number
}

export interface ReplayData {
  manifest: ReplayManifest
  blobs: Map<string, ReplayBlobRef>
}

function chunkStart(row: ChunkRow): number {
  return row.start_at ?? row.at
}

function chunkEnd(row: ChunkRow): number | null {
  if (row.end_at !== null) return row.end_at
  if (row.kind === 'screenshot') return null
  return chunkStart(row) + (row.audio_chunk_ms ?? 5000)
}

function clippedOffsetStart(start: number, from: number): number {
  return Math.max(0, start - from)
}

function clippedOffsetEnd(end: number, from: number, durationMs: number): number {
  return Math.min(durationMs, Math.max(0, end - from))
}

function toReplayChunk(row: ChunkRow, from: number, durationMs: number): ReplayChunk {
  const start = chunkStart(row)
  const end = chunkEnd(row)
  const source = chunkSource(row.kind)
  const hasBlob = row.bytes > 0 && existsSync(resolveRowBlob(row))
  const chunk: ReplayChunk = {
    id: row.id,
    kind: row.kind,
    source,
    at: row.at,
    local_at: localIso(row.at)!,
    utc_at: iso(row.at)!,
    start_at: start,
    local_start_at: localIso(start)!,
    utc_start_at: iso(start)!,
    end_at: end,
    local_end_at: localIso(end),
    utc_end_at: iso(end),
    offset_start_ms: clippedOffsetStart(start, from),
    offset_end_ms: end === null ? null : clippedOffsetEnd(end, from, durationMs),
    blob_start_offset_ms: Math.max(0, from - start),
    duration_ms: end === null ? null : Math.max(0, end - start),
    bytes: row.bytes,
    has_blob: hasBlob,
    mime_type: mimeForKind(row.kind, row.blob),
    text: row.text ?? '',
    window: windowFromRow(row),
  }
  if (row.kind !== 'screenshot') {
    chunk.audio = {
      rms_db: row.audio_rms_db,
      peak_db: row.audio_peak_db,
      engine: row.audio_engine,
      device: row.audio_device,
    }
  }
  return chunk
}

function toReplaySegment(row: SegmentRow, from: number, durationMs: number): ReplaySegment {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    source: row.source,
    start_at: row.start_at,
    local_start_at: localIso(row.start_at)!,
    utc_start_at: iso(row.start_at)!,
    end_at: row.end_at,
    local_end_at: localIso(row.end_at)!,
    utc_end_at: iso(row.end_at)!,
    offset_start_ms: clippedOffsetStart(row.start_at, from),
    offset_end_ms: clippedOffsetEnd(row.end_at, from, durationMs),
    text: row.text,
    engine: row.engine,
    transcribe_ms: row.transcribe_ms,
  }
}

// Replay plays back one machine at a time: two machines' screens interleaved on
// a single timeline would show neither. `hostId` picks which one; `hostDir` is
// what its blob paths are resolved against.
export interface ReplayStoreOptions {
  dbPath: string
  hostId?: string
  hostDir?: string
}

export class ReplayStore {
  private db: IndexDb
  readonly dbPath: string
  readonly hostId: string
  readonly hostDir: string

  constructor(options: string | ReplayStoreOptions) {
    const opts = typeof options === 'string' ? { dbPath: options } : options
    this.dbPath = opts.dbPath
    const expanded = expandHome(opts.dbPath)
    this.hostDir = opts.hostDir ?? dirname(expanded)
    this.hostId = opts.hostId ?? ''
    if (!existsSync(expanded)) throw new ReadStoreError(`index database not found at ${expanded}`)
    try {
      this.db = openReadIndexDb(expanded)
      this.db.run('PRAGMA query_only = ON')
      this.db.run('PRAGMA busy_timeout = 2000')
      const version =
        this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
      if (version < 2)
        throw new ReadStoreError(`replay requires index schema v2 or newer, got v${version}`)
    } catch (err) {
      if (err instanceof ReadStoreError) throw err
      throw new ReadStoreError(`failed to open replay database: ${String(err)}`)
    }
  }

  close(): void {
    this.db.close()
  }

  // See HyprmnesiaReadStore.stamp: rows carry no machine of their own.
  private stamp<T extends ChunkRow>(row: T): T {
    row.host = this.hostId
    row.host_dir = this.hostDir
    return row
  }

  bounds(): ReplayBounds {
    const row = this.db
      .query<{ from_ms: number | null; to_ms: number | null }, []>(
        `
        SELECT
          MIN(COALESCE(start_at, at)) AS from_ms,
          MAX(COALESCE(end_at, at)) AS to_ms
        FROM chunks
      `,
      )
      .get()
    const from = row?.from_ms ?? null
    const to = row?.to_ms ?? null
    return {
      from,
      to,
      timezone: LOCAL_TIMEZONE,
      local_from: localIso(from),
      utc_from: iso(from),
      local_to: localIso(to),
      utc_to: iso(to),
    }
  }

  load(fromInput: unknown, toInput: unknown): ReplayData {
    const from = parseTimestamp(fromInput, 'from')
    const to = parseTimestamp(toInput, 'to')
    if (from === undefined || to === undefined) throw new ReadStoreError('from and to are required')
    if (to < from) throw new ReadStoreError('to must be greater than or equal to from')
    const durationMs = to - from

    // The screenshot preceding the range fills the gap before the first frame
    // inside it, but only while it plausibly still shows what was on screen.
    // Without the age bound a range with no capture at all replays whatever was
    // captured hours or days earlier as if it were current.
    const previousScreenshot = this.db
      .query<ChunkRow, [number, number]>(
        `
        SELECT *
        FROM chunks
        WHERE kind = 'screenshot' AND at <= ? AND at >= ?
        ORDER BY at DESC
        LIMIT 1
      `,
      )
      .get(from, from - PRECEDING_SCREENSHOT_MAX_AGE_MS)
    if (previousScreenshot) this.stamp(previousScreenshot)
    const screenshotsInRange = this.db
      .query<ChunkRow, [number, number]>(
        `
        SELECT *
        FROM chunks
        WHERE kind = 'screenshot' AND at > ? AND at <= ?
        ORDER BY at ASC
      `,
      )
      .all(from, to)
      .map((row) => this.stamp(row))
    const screenshotRows = previousScreenshot
      ? [previousScreenshot, ...screenshotsInRange]
      : screenshotsInRange

    const audioRows = this.db
      .query<ChunkRow, [number, number]>(
        `
        SELECT *
        FROM chunks
        WHERE kind IN ('audio_mic', 'audio_system')
          AND COALESCE(end_at, at + COALESCE(audio_chunk_ms, 5000)) >= ?
          AND COALESCE(start_at, at) <= ?
        ORDER BY COALESCE(start_at, at) ASC
      `,
      )
      .all(from, to)
      .map((row) => this.stamp(row))

    const segmentRows = this.db
      .query<SegmentRow, [number, number]>(
        `
        SELECT *
        FROM transcript_segments
        WHERE end_at >= ? AND start_at <= ?
        ORDER BY start_at ASC
      `,
      )
      .all(from, to)

    const screenshots = screenshotRows.map((row) => toReplayChunk(row, from, durationMs))
    const audioChunks = audioRows.map((row) => toReplayChunk(row, from, durationMs))
    const blobs = new Map<string, ReplayBlobRef>()
    for (const row of [...screenshotRows, ...audioRows]) {
      const path = resolveRowBlob(row)
      if (row.bytes <= 0 || !existsSync(path)) continue
      blobs.set(row.id, {
        id: row.id,
        path,
        mime_type: mimeForKind(row.kind, row.blob),
        bytes: row.bytes,
      })
    }

    return {
      manifest: {
        from,
        to,
        duration_ms: durationMs,
        timezone: LOCAL_TIMEZONE,
        local_from: localIso(from)!,
        utc_from: iso(from)!,
        local_to: localIso(to)!,
        utc_to: iso(to)!,
        screenshots,
        audio: {
          mic: audioChunks.filter((chunk) => chunk.source === 'mic'),
          system: audioChunks.filter((chunk) => chunk.source === 'system'),
        },
        segments: segmentRows.map((row) => toReplaySegment(row, from, durationMs)),
      },
      blobs,
    }
  }
}

// Defaults to this machine's own index. `hostId` replays another machine's
// recording out of the shared folder.
export function withReplayStore<T>(
  dbPath: string | undefined,
  fn: (store: ReplayStore) => T,
  hostId?: string,
): T {
  const hosts = cachedHostSources(dbPath)
  const host = hostId ? hosts.find((h) => h.hostId === hostId) : hosts.find((h) => h.isLocal)
  if (!host) throw new ReadStoreError(`no index found for host ${hostId ?? '(local)'}`)
  const store = new ReplayStore({ dbPath: host.dbPath, hostId: host.hostId, hostDir: host.dir })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}
