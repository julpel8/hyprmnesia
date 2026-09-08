import {
  chunkSource,
  excerpt,
  iso,
  LOCAL_TIMEZONE,
  localIso,
  numericRange,
  textPresent,
  toTimelineItem,
} from './format'
import type {
  ActivityGroup,
  AudioGroupDiagnostics,
  ChunkRow,
  TimelineItem,
  WindowPayload,
} from './types'

interface ActivityAccumulator {
  id: string
  key: string
  start_at: number
  end_at: number
  window: WindowPayload
  chunks: TimelineItem[]
  fullTextParts: string[]
  sources: Set<'screen' | 'mic' | 'system'>
  chunk_ids_by_source: Record<'screen' | 'mic' | 'system', string[]>
  transcriptSegments: number
}

function rowStart(row: ChunkRow): number {
  return row.start_at ?? row.at
}

function rowEnd(row: ChunkRow): number {
  return row.end_at ?? row.at
}

function hasWindow(row: ChunkRow): boolean {
  return Boolean(row.window_url || row.window_app || row.window_title)
}

function windowKey(row: ChunkRow): string {
  if (row.window_url) return `url:${row.window_url}`
  if (row.window_app || row.window_title)
    return `window:${row.window_app ?? ''}|${row.window_title ?? ''}`
  return `source:${chunkSource(row.kind)}`
}

function sourceOrder(source: 'screen' | 'mic' | 'system'): number {
  if (source === 'screen') return 0
  if (source === 'system') return 1
  return 2
}

function extractUrlCandidate(text: string): string | null {
  const match = text.match(
    /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"']+)/i,
  )
  if (!match?.[0]) return null
  const candidate = match[0].replace(/[),.;:!?]+$/g, '')
  return candidate.includes('.') ? candidate : null
}

function createActivity(row: ChunkRow, key: string): ActivityAccumulator {
  const item = toTimelineItem(row)
  return {
    id: `activity:${row.id}`,
    key,
    start_at: rowStart(row),
    end_at: rowEnd(row),
    window: item.window,
    chunks: [],
    fullTextParts: [],
    sources: new Set(),
    chunk_ids_by_source: { screen: [], mic: [], system: [] },
    transcriptSegments: 0,
  }
}

function addRowToActivity(group: ActivityAccumulator, row: ChunkRow): void {
  const item = toTimelineItem(row)
  const source = item.source
  group.start_at = Math.min(group.start_at, rowStart(row))
  group.end_at = Math.max(group.end_at, rowEnd(row))
  group.chunks.push(item)
  group.sources.add(source)
  group.chunk_ids_by_source[source].push(row.id)
  group.transcriptSegments += item.segment_count
  if (textPresent(row.text)) group.fullTextParts.push(row.text)
  if (!group.window.url && item.window.url) group.window.url = item.window.url
  if (!group.window.app && item.window.app) group.window.app = item.window.app
  if (!group.window.title && item.window.title) group.window.title = item.window.title
  if (!group.window.pid && item.window.pid) group.window.pid = item.window.pid
}

function canAppendToWindowGroup(group: ActivityAccumulator, row: ChunkRow): boolean {
  if (!hasWindow(row)) return false
  return group.key === windowKey(row) && rowStart(row) - group.end_at <= 30_000
}

function overlaps(group: ActivityAccumulator, row: ChunkRow): boolean {
  return rowStart(row) <= group.end_at && rowEnd(row) >= group.start_at
}

function findRecentGroup(
  groups: ActivityAccumulator[],
  predicate: (group: ActivityAccumulator) => boolean,
): ActivityAccumulator | undefined {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    if (group && predicate(group)) return group
  }
  return undefined
}

function audioSummary(
  items: TimelineItem[],
  source: 'mic' | 'system',
): AudioGroupDiagnostics | undefined {
  const audio = items.filter((item) => item.source === source && item.audio)
  if (audio.length === 0) return undefined
  const rms = numericRange(audio.map((item) => item.audio?.rms_db))
  const peak = numericRange(audio.map((item) => item.audio?.peak_db))
  const states = Array.from(new Set(audio.map((item) => item.audio!.state)))
  return {
    segment_count: audio.reduce((sum, item) => sum + (item.audio?.segment_count ?? 0), 0),
    states,
    rms_db_min: rms.min,
    rms_db_max: rms.max,
    peak_db_max: peak.max,
  }
}

function toActivityGroup(group: ActivityAccumulator): ActivityGroup {
  const sortedChunks = [...group.chunks].sort(
    (a, b) => a.at - b.at || sourceOrder(a.source) - sourceOrder(b.source),
  )
  const nativeUrl = group.window.url
  const text = group.fullTextParts.join(' ')
  const candidate = nativeUrl ? null : extractUrlCandidate(text)
  return {
    id: group.id,
    start_at: group.start_at,
    timezone: LOCAL_TIMEZONE,
    local_start_at: localIso(group.start_at)!,
    utc_start_at: iso(group.start_at)!,
    iso_start_at: iso(group.start_at)!,
    end_at: group.end_at,
    local_end_at: localIso(group.end_at)!,
    utc_end_at: iso(group.end_at)!,
    iso_end_at: iso(group.end_at)!,
    duration_ms: Math.max(0, group.end_at - group.start_at),
    sources: (['screen', 'system', 'mic'] as const).filter((source) => group.sources.has(source)),
    window: group.window,
    url: nativeUrl,
    url_candidate: candidate,
    url_source: nativeUrl ? 'native' : candidate ? 'ocr_candidate' : 'none',
    url_confidence: nativeUrl ? 'high' : candidate ? 'low' : 'none',
    text_preview: excerpt(text, 600),
    chunk_ids: sortedChunks.map((item) => item.id),
    chunk_ids_by_source: group.chunk_ids_by_source,
    counts: {
      chunks: sortedChunks.length,
      screen: group.chunk_ids_by_source.screen.length,
      mic: group.chunk_ids_by_source.mic.length,
      system: group.chunk_ids_by_source.system.length,
      transcript_segments: group.transcriptSegments,
    },
    audio: {
      mic: audioSummary(sortedChunks, 'mic'),
      system: audioSummary(sortedChunks, 'system'),
    },
  }
}

export function buildActivityGroups(rows: ChunkRow[]): ActivityGroup[] {
  const groups: ActivityAccumulator[] = []
  const unwindowedAudio: ChunkRow[] = []

  for (const row of rows) {
    if (row.kind !== 'screenshot' && !hasWindow(row)) {
      unwindowedAudio.push(row)
      continue
    }
    let group = findRecentGroup(groups, (candidate) => canAppendToWindowGroup(candidate, row))
    if (!group) {
      group = createActivity(row, windowKey(row))
      groups.push(group)
    }
    addRowToActivity(group, row)
  }

  for (const row of unwindowedAudio) {
    let group = findRecentGroup(
      groups,
      (candidate) => candidate.sources.has('screen') && overlaps(candidate, row),
    )
    if (!group) {
      const key = `audio:${chunkSource(row.kind)}`
      group = findRecentGroup(
        groups,
        (candidate) => candidate.key === key && rowStart(row) - candidate.end_at <= 30_000,
      )
    }
    if (!group) {
      group = createActivity(row, `audio:${chunkSource(row.kind)}`)
      groups.push(group)
    }
    addRowToActivity(group, row)
  }

  return groups.sort((a, b) => a.start_at - b.start_at).map(toActivityGroup)
}
