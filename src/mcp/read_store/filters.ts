import { clampInt } from '../../util/num'
import type { SearchMode, SourceFilter } from './types'

export class ReadStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadStoreError'
  }
}

export function clampLimit(value: unknown, fallback = 20): number {
  return clampInt(value, 1, 100, fallback)
}

export function clampOffset(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

export function parseTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ReadStoreError(`${name} must be a finite epoch-ms number or ISO date`)
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && value.trim() !== '') return Math.trunc(asNumber)
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed))
      throw new ReadStoreError(`${name} must be an epoch-ms number or ISO date`)
    return parsed
  }
  throw new ReadStoreError(`${name} must be an epoch-ms number or ISO date`)
}

export function normalizeSource(value: unknown): SourceFilter | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'screen' || value === 'screenshot') return 'screen'
  if (value === 'mic' || value === 'audio_mic') return 'mic'
  if (value === 'system' || value === 'audio_system') return 'system'
  throw new ReadStoreError('source must be one of: screen, mic, system')
}

export function normalizeSources(value: unknown): SourceFilter[] {
  if (value === undefined || value === null || value === '') return ['screen', 'mic', 'system']
  if (!Array.isArray(value)) throw new ReadStoreError('sources must be an array')
  const out: SourceFilter[] = []
  for (const item of value) {
    const source = normalizeSource(item)
    if (source && !out.includes(source)) out.push(source)
  }
  return out.length > 0 ? out : ['screen', 'mic', 'system']
}

export function normalizeMode(value: unknown): SearchMode {
  if (value === undefined || value === null || value === '') return 'hybrid'
  if (value === 'lexical' || value === 'semantic' || value === 'hybrid') return value
  throw new ReadStoreError('mode must be one of: lexical, semantic, hybrid')
}

export function buildFtsQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new ReadStoreError('query is required')
  }
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? []
  if (tokens.length === 0)
    throw new ReadStoreError('query must contain at least one searchable token')
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}
