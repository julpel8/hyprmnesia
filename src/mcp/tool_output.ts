// Plain-text renderings of MCP tool results (the `content[].text` block). The
// structured payload travels separately; these are the human-readable summaries
// shown to assistants that don't parse structuredContent.
import { shortDuration } from '../util/format'
import type { PeriodActivityResult } from './read_store'

export function linesForSearch(
  results: Array<{
    local_time: string
    timezone: string
    source: string
    snippet: string
    id: string
    type: string
  }>,
): string {
  if (results.length === 0) return 'No matching Hyprmnesia memories.'
  return results
    .slice(0, 10)
    .map(
      (r) =>
        `- ${r.local_time} ${r.timezone} ${r.source} ${r.type} ${r.id}: ${r.snippet || '(no text)'}`,
    )
    .join('\n')
}

export function linesForTimeline(
  items: Array<{
    local_at: string
    timezone: string
    source: string
    id: string
    text: string
    window: { app: string | null; title: string | null }
    audio?: { state: string; segment_count: number; rms_db: number | null; peak_db: number | null }
  }>,
): string {
  if (items.length === 0) return 'No Hyprmnesia captures in this range.'
  return items
    .slice(0, 12)
    .map((item) => {
      const window = [item.window.app, item.window.title].filter(Boolean).join(' - ')
      const audio = item.audio
        ? ` [${item.audio.state}, segments=${item.audio.segment_count}, rms=${item.audio.rms_db ?? 'n/a'}, peak=${item.audio.peak_db ?? 'n/a'}]`
        : ''
      return `- ${item.local_at} ${item.timezone} ${item.source} ${item.id}${window ? ` (${window})` : ''}${audio}: ${item.text || '(no text)'}`
    })
    .join('\n')
}

export function linesForRecentActivity(
  groups: Array<{
    local_start_at: string
    local_end_at: string
    timezone: string
    sources: string[]
    window: { app: string | null; title: string | null }
    url: string | null
    url_candidate: string | null
    url_confidence: string
    text_preview: string
    counts: { chunks: number; transcript_segments: number }
    audio: {
      mic?: { states: string[]; segment_count: number }
      system?: { states: string[]; segment_count: number }
    }
  }>,
): string {
  if (groups.length === 0) return 'No recent Hyprmnesia activity in this range.'
  return groups
    .slice(0, 8)
    .map((group) => {
      const window = [group.window.app, group.window.title].filter(Boolean).join(' - ')
      const url = group.url
        ? ` url=${group.url}`
        : group.url_candidate
          ? ` url_candidate=${group.url_candidate} (${group.url_confidence})`
          : ''
      const audio = [
        group.audio.system
          ? `system:${group.audio.system.states.join('|')}/${group.audio.system.segment_count}`
          : '',
        group.audio.mic
          ? `mic:${group.audio.mic.states.join('|')}/${group.audio.mic.segment_count}`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `- ${group.local_start_at}..${group.local_end_at} ${group.timezone} [${group.sources.join(',')}]${window ? ` (${window})` : ''}${url} chunks=${group.counts.chunks} transcripts=${group.counts.transcript_segments}${audio ? ` ${audio}` : ''}: ${group.text_preview || '(no text)'}`
    })
    .join('\n')
}

export function linesForPeriodActivity(result: PeriodActivityResult): string {
  if (result.days.length === 0) return 'No Hyprmnesia activity in this range.'
  const lines: string[] = []
  for (const day of result.days) {
    const top = day.by_app
      .slice(0, 3)
      .map((row) => `${row.key} ${shortDuration(row.estimated_active_ms)}`)
      .join(', ')
    lines.push(
      `- ${day.date}: ${day.sessions} sessions, ~${shortDuration(day.estimated_active_ms)} active${top ? ` (${top})` : ''}`,
    )
  }
  for (const session of result.sessions.slice(0, 10)) {
    const where = [session.app, session.project?.repo ?? session.project?.ssh_host, session.domain]
      .filter(Boolean)
      .join(' / ')
    const preview = session.excerpts[0]?.text ?? '(no text)'
    lines.push(
      `  - ${session.local_start_at}..${session.local_end_at} ${session.timezone} [${session.sources.join(',')}]${where ? ` (${where})` : ''} ~${shortDuration(session.estimated_active_ms)}: ${preview}`,
    )
  }
  if (result.next_cursor) lines.push(`  (truncated; continue with cursor=${result.next_cursor})`)
  return lines.join('\n')
}
