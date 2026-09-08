import { cachedHostSources, type HostSource } from '../../store/hosts'
import { encodeCursor } from './cursor'
import { clampLimit, clampOffset, ReadStoreError } from './filters'
import { HyprmnesiaReadStore, rrfFuseMany } from './index'
import {
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
  SearchResult,
  SegmentResult,
  SegmentRow,
  TimelineItem,
} from './types'

export interface FederatedReadStoreOptions {
  hosts: HostSource[]
  // Called when a machine's index cannot be opened. Syncthing may be halfway
  // through copying it, so this is a normal transient condition and never fatal.
  onWarning?: (message: string) => void
}

// Reads every machine's index and answers as if they were one.
//
// Same public surface as HyprmnesiaReadStore. Each database is opened
// read-only; nothing here ever writes outside the local machine's own files.
export class FederatedReadStore {
  readonly stores: HyprmnesiaReadStore[] = []
  readonly skipped: string[] = []

  constructor(options: FederatedReadStoreOptions) {
    for (const host of options.hosts) {
      try {
        this.stores.push(
          new HyprmnesiaReadStore({ dbPath: host.dbPath, hostId: host.hostId, hostDir: host.dir }),
        )
      } catch (err) {
        this.skipped.push(host.hostId)
        options.onWarning?.(`skipping index of host ${host.hostId}: ${String(err)}`)
      }
    }
    if (this.stores.length === 0) {
      throw new Error('no readable index database found')
    }
  }

  close(): void {
    for (const store of this.stores) {
      try {
        store.close()
      } catch {
        // A database that failed mid-read is of no further use; nothing to do.
      }
    }
  }

  search(query: string, filters: QueryFilters): SearchResult[] {
    const limit = clampLimit(filters.limit)
    const offset = clampOffset(filters.offset)
    // A single machine keeps its native scores (BM25, or vector distance);
    // re-fusing one list would replace them with rank scores for nothing.
    if (this.stores.length === 1) return this.stores[0]!.search(query, filters)
    const lists = this.stores.map((store) =>
      store.search(query, { ...filters, limit: limit + offset, offset: 0 }),
    )
    return rrfFuseMany(lists, limit, offset)
  }

  timeline(filters: QueryFilters & { from: number; to: number }): TimelineItem[] {
    const limit = clampLimit(filters.limit)
    const offset = clampOffset(filters.offset)
    if (this.stores.length === 1) return this.stores[0]!.timeline(filters)
    // Each machine returns its own earliest `limit + offset` items, so the
    // merged earliest `limit + offset` are all in hand.
    const merged = this.stores
      .flatMap((store) => store.timeline({ ...filters, limit: limit + offset, offset: 0 }))
      .sort((a, b) => a.at - b.at || compareIds(a.id, b.id))
    return merged.slice(offset, offset + limit)
  }

  recentActivity(filters: RecentActivityFilters): RecentActivityResult {
    const limit = clampLimit(filters.limit, 50)
    if (this.stores.length === 1) return this.stores[0]!.recentActivity(filters)
    // Grouping stays per machine: an activity is one machine's stretch of work,
    // and merging raw rows would stitch two machines into a single session.
    const results = this.stores.map((store) => store.recentActivity(filters))
    const groups = results
      .flatMap((result) => result.groups)
      .sort((a, b) => a.start_at - b.start_at || compareIds(a.id, b.id))
    const page = groups.slice(Math.max(0, groups.length - limit))
    const truncated = results.some((result) => result.truncated) || groups.length > limit
    // `start_at` is the earliest moment of a group, so it is at or before the
    // oldest row it holds: the next page overlaps rather than skips.
    const next_cursor =
      truncated && page.length > 0
        ? encodeRecentCursor(Math.min(...page.map((group) => group.start_at)))
        : null
    return { groups: page, truncated, next_cursor }
  }

  periodActivity(filters: PeriodActivityFilters): PeriodActivityResult {
    if (this.stores.length === 1) return this.stores[0]!.periodActivity(filters)
    // Sessions are built once over the merged rows. Adding up per-machine
    // aggregates would double-count overlapping stretches of time.
    return walkPeriodDays(filters, (from, to) => this.mergeDayRows(from, to, filters))
  }

  private mergeDayRows(
    from: number,
    to: number,
    filters: Pick<PeriodActivityFilters, 'sources' | 'app'>,
  ): PeriodDayRows {
    const rows: ChunkRow[] = []
    const segments: SegmentRow[] = []
    let capped = false
    for (const store of this.stores) {
      const day = store.periodDayRows(from, to, filters)
      rows.push(...day.rows)
      segments.push(...day.segments)
      capped ||= day.capped
    }
    rows.sort((a, b) => a.at - b.at || compareIds(a.id, b.id))
    segments.sort((a, b) => a.start_at - b.start_at || compareIds(a.id, b.id))
    return { rows, segments, capped }
  }

  // Chunk and segment ids are UUIDv7, unique across machines: the first
  // database that holds one is the right one.
  recall(id: string, includeBlob: boolean): RecallResult {
    for (const store of this.stores) {
      const result = store.recall(id, includeBlob)
      if (result.found) return result
    }
    return { found: false }
  }

  getTranscriptSegment(id: string, includeChunk: boolean): SegmentResult {
    for (const store of this.stores) {
      const result = store.getTranscriptSegment(id, includeChunk)
      if (result.found) return result
    }
    return { found: false }
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encodeRecentCursor(beforeAt: number): string {
  return encodeCursor({ v: 1, t: 'ra', before_at: beforeAt })
}

export interface WithFederatedReadStoreOptions {
  // Restrict the read to one machine's index. Absent means every machine found
  // in the shared storage root, which is the default for every read route.
  hostId?: string
  onWarning?: (message: string) => void
}

// Opens every machine's index for the duration of one call. `localDbPath`
// overrides the live local index (`--db`, tests).
export function withFederatedReadStore<T>(
  localDbPath: string | undefined,
  fn: (store: FederatedReadStore) => T,
  options: WithFederatedReadStoreOptions = {},
): T {
  const hosts = selectHosts(cachedHostSources(localDbPath), options.hostId)
  const store = new FederatedReadStore({ hosts, onWarning: options.onWarning })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

// An unknown host is a caller mistake, not an empty result: answering with the
// other machines' data would silently ignore the filter.
function selectHosts(hosts: HostSource[], hostId: string | undefined): HostSource[] {
  if (hostId === undefined) return hosts
  const selected = hosts.filter((host) => host.hostId === hostId)
  if (selected.length === 0) throw new ReadStoreError(`unknown host: ${hostId}`)
  return selected
}
