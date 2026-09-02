import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_TTL_MS = 8_000
const MAX_TTL_MS = 30_000
const CACHE_MS = 250

interface SuppressionMarker {
  owner?: string
  until: number
  updated_at: number
}

interface SuppressionOptions {
  file?: string
  now?: number
  owner?: string
  ttlMs?: number
}

let cachedFile = ''
let cachedCheckedAt = 0
let cachedUntil = 0

function replayTranscriptionSuppressionPath(): string {
  return join(homedir(), '.hyprmnesia', 'replay-transcription-suppression.json')
}

function markerFile(opts: SuppressionOptions): string {
  return opts.file ?? replayTranscriptionSuppressionPath()
}

function parseMarker(raw: string): SuppressionMarker | undefined {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.until !== 'number') return undefined
    return {
      owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
      until: parsed.until,
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
    }
  } catch {
    return undefined
  }
}

function readMarker(file: string): SuppressionMarker | undefined {
  try {
    return parseMarker(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function resetCache(file: string): void {
  if (cachedFile !== file) return
  cachedCheckedAt = 0
  cachedUntil = 0
}

export function setReplayTranscriptionSuppression(opts: SuppressionOptions = {}): number {
  const file = markerFile(opts)
  const now = opts.now ?? Date.now()
  const ttlMs = Math.max(1, Math.min(MAX_TTL_MS, Math.trunc(opts.ttlMs ?? DEFAULT_TTL_MS)))
  const marker: SuppressionMarker = {
    owner: opts.owner,
    until: now + ttlMs,
    updated_at: now,
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(marker))
  renameSync(tmp, file)
  cachedFile = file
  cachedCheckedAt = now
  cachedUntil = marker.until
  return marker.until
}

export function clearReplayTranscriptionSuppression(opts: SuppressionOptions = {}): boolean {
  const file = markerFile(opts)
  const marker = readMarker(file)
  if (opts.owner && marker?.owner && marker.owner !== opts.owner) return false
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {}
  resetCache(file)
  return true
}

export function isReplayTranscriptionSuppressed(opts: SuppressionOptions = {}): boolean {
  const file = markerFile(opts)
  const now = opts.now ?? Date.now()
  if (cachedFile === file && now - cachedCheckedAt < CACHE_MS) return cachedUntil > now

  const marker = readMarker(file)
  cachedFile = file
  cachedCheckedAt = now
  cachedUntil = marker?.until ?? 0

  if (cachedUntil > now) return true
  if (marker && cachedUntil <= now) {
    try {
      unlinkSync(file)
    } catch {}
  }
  return false
}
