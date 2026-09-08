import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pad } from '../../util/format'
import type {
  AudioState,
  ChunkRow,
  SegmentRow,
  SourceFilter,
  TimelineItem,
  TranscriptSegment,
  WindowPayload,
} from './types'

export const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'

export function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null
}

export function localIso(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number') return null
  const d = new Date(ms)
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function chunkSource(kind: ChunkRow['kind']): 'screen' | 'mic' | 'system' {
  if (kind === 'screenshot') return 'screen'
  if (kind === 'audio_mic') return 'mic'
  return 'system'
}

export function kindForSource(source: SourceFilter | undefined): ChunkRow['kind'] | undefined {
  if (source === 'screen') return 'screenshot'
  if (source === 'mic') return 'audio_mic'
  if (source === 'system') return 'audio_system'
  return undefined
}

export function windowFromRow(
  row: Pick<ChunkRow, 'window_app' | 'window_title' | 'window_url' | 'window_pid'>,
): WindowPayload {
  return {
    app: row.window_app,
    title: row.window_title,
    url: row.window_url,
    pid: row.window_pid,
  }
}

export function excerpt(text: string | null | undefined, max = 280): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3).trimEnd()}...`
}

export function textPresent(text: string | null | undefined): boolean {
  return (text ?? '').trim().length > 0
}

export function numericRange(values: Array<number | null | undefined>): {
  min: number | null
  max: number | null
} {
  const nums = values.filter((value): value is number => typeof value === 'number')
  if (nums.length === 0) return { min: null, max: null }
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

// `chunks.blob` holds a path relative to the machine that recorded it. Rows
// stamped with a `host_dir` are resolved against it; rows without one are left
// as-is so a database opened on its own still works.
export function resolveRowBlob(row: Pick<ChunkRow, 'blob' | 'host_dir'>): string {
  return row.host_dir ? join(row.host_dir, row.blob) : row.blob
}

export function mimeForKind(kind: ChunkRow['kind'], blob: string): string {
  const lower = blob.toLowerCase()
  if (kind === 'screenshot') {
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.webp')) return 'image/webp'
    return 'image/png'
  }
  if (lower.endsWith('.webm')) return 'audio/webm; codecs=opus'
  return 'audio/wav'
}

function audioState(row: ChunkRow, segmentCount: number, now = Date.now()): AudioState {
  if (row.kind === 'screenshot') return 'captured_no_transcript'
  if (segmentCount > 0 || textPresent(row.text)) return 'transcribed'
  if (!row.end_at || row.bytes <= 0) return 'recording'
  const endedAt = row.end_at ?? row.at
  if (row.audio_engine === 'pending' && now - endedAt < 120_000) return 'pending'
  if (
    (typeof row.audio_peak_db === 'number' && row.audio_peak_db <= -75) ||
    (typeof row.audio_rms_db === 'number' && row.audio_rms_db <= -85)
  ) {
    return 'quiet_no_transcript'
  }
  return 'captured_no_transcript'
}

export function toTimelineItem(row: ChunkRow, segmentCount = row.segment_count ?? 0): TimelineItem {
  const start = row.start_at ?? row.at
  const end = row.end_at
  const item: TimelineItem = {
    id: row.id,
    kind: row.kind,
    source: chunkSource(row.kind),
    at: row.at,
    timezone: LOCAL_TIMEZONE,
    local_at: localIso(row.at)!,
    utc_at: iso(row.at)!,
    iso_at: iso(row.at)!,
    start_at: row.start_at,
    local_start_at: localIso(row.start_at),
    utc_start_at: iso(row.start_at),
    iso_start_at: iso(row.start_at),
    end_at: end,
    local_end_at: localIso(end),
    utc_end_at: iso(end),
    iso_end_at: iso(end),
    duration_ms: typeof end === 'number' ? Math.max(0, end - start) : null,
    text: excerpt(row.text),
    text_len: row.text?.length ?? 0,
    has_blob: row.bytes > 0 && existsSync(resolveRowBlob(row)),
    bytes: row.bytes,
    window: windowFromRow(row),
    segment_count: segmentCount,
    ...(row.host ? { host: row.host } : {}),
  }
  if (row.kind !== 'screenshot') {
    item.audio = {
      rms_db: row.audio_rms_db,
      peak_db: row.audio_peak_db,
      engine: row.audio_engine,
      device: row.audio_device,
      segment_count: segmentCount,
      state: audioState(row, segmentCount),
    }
  }
  return item
}

export function toSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    source: row.source,
    start_at: row.start_at,
    timezone: LOCAL_TIMEZONE,
    local_start_at: localIso(row.start_at)!,
    utc_start_at: iso(row.start_at)!,
    iso_start_at: iso(row.start_at)!,
    end_at: row.end_at,
    local_end_at: localIso(row.end_at)!,
    utc_end_at: iso(row.end_at)!,
    iso_end_at: iso(row.end_at)!,
    text: row.text,
    engine: row.engine,
    transcribe_ms: row.transcribe_ms,
    role: row.role ?? 'primary',
  }
}
