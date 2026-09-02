// Read-only replay data routes, absorbed from the old replay server. These work
// with the daemon stopped: each request opens the index DB read-only via
// withReplayStore. Blob bytes are served from the `blobs` map most recently
// populated by /api/manifest (an id → ReplayBlobRef cache).

import { readFileSync } from 'node:fs'
import {
  clampLimit,
  clampOffset,
  normalizeSource,
  normalizeSources,
  parseTimestamp,
  type QueryFilters,
  ReadStoreError,
  type RecentActivityFilters,
} from '../../mcp/read_store'
import { withFederatedReadStore } from '../../mcp/read_store/federated'
import { sliceRange } from '../../replay/range'
import type { ReplayBlobRef, ReplayChunk, ReplayManifest } from '../../replay/store'
import { withReplayStore } from '../../replay/store'
import { cachedHostSources } from '../../store/hosts'
import { defaultDbPath } from '../../util/paths'
import { repairWebpRiffSize } from '../../util/webp'

export interface ReadContext {
  dbPath?: string
  // Mutable holder: /api/manifest replaces `.current` with the range's blob refs
  // so a later /media/:id can resolve the bytes.
  blobs: { current: Map<string, ReplayBlobRef> }
  headers: (extra?: Record<string, string>) => Record<string, string>
}

export function withBlobUrls(manifest: ReplayManifest): ReplayManifest {
  const addUrl = (chunk: ReplayChunk): ReplayChunk => ({
    ...chunk,
    blob_url: chunk.has_blob ? `/media/${encodeURIComponent(chunk.id)}` : null,
  })
  return {
    ...manifest,
    screenshots: manifest.screenshots.map(addUrl),
    audio: {
      mic: manifest.audio.mic.map(addUrl),
      system: manifest.audio.system.map(addUrl),
    },
    segments: manifest.segments.map((segment) => ({ ...segment })),
  }
}

// Serves a blob, honouring Range requests (used by the <audio> element for
// scrubbing).
function serveBlob(req: Request, blob: ReplayBlobRef, headers: Record<string, string>): Response {
  let data: Buffer
  try {
    data = readFileSync(blob.path)
  } catch {
    return new Response('not found', { status: 404, headers })
  }
  if (blob.mime_type === 'image/webp') data = repairWebpRiffSize(data)
  const total = data.length
  const range = sliceRange(total, req.headers.get('range'))
  if (range) {
    const body = data.subarray(range.start, range.end + 1)
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Type': blob.mime_type,
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }
  return new Response(data, {
    headers: {
      ...headers,
      'Content-Type': blob.mime_type,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    },
  })
}

// Dispatches a read route. Returns a Response when the path matches one, or
// undefined to let the caller fall through to other handlers / 404.
export function handleReadRequest(req: Request, url: URL, ctx: ReadContext): Response | undefined {
  // Replay plays one machine at a time; this is what the machine picker lists.
  if (url.pathname === '/api/hosts') {
    const hosts = cachedHostSources(ctx.dbPath).map((host) => ({
      host_id: host.hostId,
      is_local: host.isLocal,
    }))
    return Response.json(hosts, { headers: ctx.headers() })
  }

  if (url.pathname === '/api/range') {
    try {
      const host = url.searchParams.get('host') ?? undefined
      const bounds = withReplayStore(ctx.dbPath, (store) => store.bounds(), host)
      return Response.json(bounds, { headers: ctx.headers() })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), {
        status: 500,
        headers: ctx.headers(),
      })
    }
  }

  if (url.pathname === '/api/manifest') {
    try {
      const data = withReplayStore(
        ctx.dbPath,
        (store) => store.load(url.searchParams.get('from'), url.searchParams.get('to')),
        url.searchParams.get('host') ?? undefined,
      )
      ctx.blobs.current = data.blobs
      return Response.json(withBlobUrls(data.manifest), { headers: ctx.headers() })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), {
        status: 400,
        headers: ctx.headers(),
      })
    }
  }

  if (url.pathname === '/api/search') {
    try {
      const filters: QueryFilters = {
        from: parseTimestamp(url.searchParams.get('from'), 'from'),
        to: parseTimestamp(url.searchParams.get('to'), 'to'),
        source: normalizeSource(url.searchParams.get('source') ?? undefined),
        app: url.searchParams.get('app') ?? undefined,
        limit: clampLimit(url.searchParams.get('limit')),
        offset: clampOffset(url.searchParams.get('offset')),
        // v1 is lexical-only: semantic/hybrid need the embedder for a query
        // vector (tracked separately).
        mode: 'lexical',
      }
      const results = withFederatedReadStore(dbPathOf(ctx), (s) =>
        s.search(url.searchParams.get('q') ?? '', filters),
      )
      return Response.json({ results }, { headers: ctx.headers() })
    } catch (err) {
      return readStoreError(err, ctx)
    }
  }

  if (url.pathname === '/api/timeline') {
    try {
      const from = parseTimestamp(url.searchParams.get('from'), 'from')
      const to = parseTimestamp(url.searchParams.get('to'), 'to')
      if (from === undefined || to === undefined) {
        return new Response('timeline requires from and to', {
          status: 400,
          headers: ctx.headers(),
        })
      }
      const items = withFederatedReadStore(dbPathOf(ctx), (s) =>
        s.timeline({
          from,
          to,
          source: normalizeSource(url.searchParams.get('source') ?? undefined),
          app: url.searchParams.get('app') ?? undefined,
          limit: clampLimit(url.searchParams.get('limit')),
          offset: clampOffset(url.searchParams.get('offset')),
          includeEmpty: url.searchParams.get('includeEmpty') === '1',
        }),
      )
      return Response.json({ items }, { headers: ctx.headers() })
    } catch (err) {
      return readStoreError(err, ctx)
    }
  }

  if (url.pathname === '/api/activity') {
    try {
      const from = parseTimestamp(url.searchParams.get('from'), 'from')
      const to = parseTimestamp(url.searchParams.get('to'), 'to')
      if (from === undefined || to === undefined) {
        return new Response('activity requires from and to', {
          status: 400,
          headers: ctx.headers(),
        })
      }
      const sourcesParam = url.searchParams.get('sources')
      const filters: RecentActivityFilters = {
        from,
        to,
        sources: normalizeSources(sourcesParam ? sourcesParam.split(',') : undefined),
        app: url.searchParams.get('app') ?? undefined,
        limit: clampLimit(url.searchParams.get('limit')),
        includeEmpty: url.searchParams.get('includeEmpty') === '1',
      }
      const result = withFederatedReadStore(dbPathOf(ctx), (s) => s.recentActivity(filters))
      return Response.json(result, { headers: ctx.headers() })
    } catch (err) {
      return readStoreError(err, ctx)
    }
  }

  const recallMatch = url.pathname.match(/^\/api\/recall\/(.+)$/)
  if (recallMatch?.[1]) {
    try {
      const id = decodeURIComponent(recallMatch[1])
      const result = withFederatedReadStore(dbPathOf(ctx), (s) => s.recall(id, false))
      return Response.json(result, { headers: ctx.headers() })
    } catch (err) {
      return readStoreError(err, ctx)
    }
  }

  const blobMatch = url.pathname.match(/^\/(?:blob|media)\/([^/]+)$/)
  if (blobMatch?.[1]) {
    const id = decodeURIComponent(blobMatch[1])
    // First the range-scoped manifest cache (replay); then fall back to the read
    // store so any chunk id (search/timeline thumbnails) resolves to its blob.
    const cached = ctx.blobs.current.get(id)
    if (cached) return serveBlob(req, cached, ctx.headers())
    const resolved = resolveBlobRef(ctx, id)
    if (resolved) return serveBlob(req, resolved, ctx.headers())
    return new Response('not found', { status: 404, headers: ctx.headers() })
  }

  return undefined
}

function dbPathOf(ctx: ReadContext): string {
  return ctx.dbPath ?? defaultDbPath()
}

// A bad request (invalid filter) is a ReadStoreError → 400; anything else
// (missing/locked DB) → 500.
function readStoreError(err: unknown, ctx: ReadContext): Response {
  const message = err instanceof Error ? err.message : String(err)
  const status = err instanceof ReadStoreError ? 400 : 500
  return new Response(message, { status, headers: ctx.headers() })
}

// Resolves a chunk id to a servable blob via the read store, or undefined when
// the chunk/blob is absent or the DB can't be opened.
function resolveBlobRef(ctx: ReadContext, id: string): ReplayBlobRef | undefined {
  try {
    return withFederatedReadStore(dbPathOf(ctx), (s) => {
      const recalled = s.recall(id, true)
      const chunk = recalled.chunk
      if (!recalled.found || !chunk?.blob_path) return undefined
      return {
        id,
        path: chunk.blob_path,
        mime_type: chunk.mime_type ?? 'application/octet-stream',
        bytes: chunk.bytes,
      }
    })
  } catch {
    return undefined
  }
}
