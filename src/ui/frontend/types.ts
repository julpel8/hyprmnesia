// Frontend view of the JSON contract served by src/ui/api. These mirror the
// server types in src/replay/store.ts (ReplayChunk/ReplaySegment/ReplayManifest/
// ReplayBounds) but are declared here so the browser bundle stays decoupled from
// the node-coupled backend modules. Keep in sync with that file.

interface ReplayWindow {
  app: string | null
  title: string | null
  url: string | null
  pid: number | null
}

export interface ReplayChunk {
  id: string
  kind: string
  source: 'screen' | 'mic' | 'system'
  at: number
  local_at: string
  utc_at: string
  start_at: number
  end_at: number | null
  offset_start_ms: number
  offset_end_ms: number | null
  blob_start_offset_ms: number
  duration_ms: number | null
  bytes: number
  has_blob: boolean
  mime_type: string
  text: string
  window: ReplayWindow
  blob_url?: string | null
}

interface ReplaySegment {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  offset_start_ms: number
  offset_end_ms: number
  text: string
  engine: string
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

// One machine present in the shared storage tree. Replay shows one at a time.
export interface ReplayHost {
  host_id: string
  is_local: boolean
}

export interface SettingFieldDescriptor {
  label: string
  path: string[]
  kind: 'bool' | 'enum' | 'number' | 'text'
  hint: string
  choices?: unknown[]
  step?: number
  min?: number
  max?: number
}

export interface SearchResult {
  id: string
  type: 'chunk' | 'transcript_segment'
  source: 'screen' | 'mic' | 'system'
  time: number
  local_time: string
  end_time?: number | null
  snippet: string
  score: number
  chunk_id: string
  window: ReplayWindow
}
