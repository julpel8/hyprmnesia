import { loadConfig } from '../config'
import { makeEmbedding } from '../process/embeddings'
import type { EmbeddingEngine } from '../process/types'
import { defaultDbPath, expandHome } from '../util/paths'
import { VERSION } from '../version'
import { boolArg, numberArg, rejectUnknownArgs, stringArg, validateRange } from './args'
import {
  type ApiAuthStore,
  apiAuthFailureMessage,
  createDefaultApiAuthStore,
  isApiAuthConfigured,
  verifyApiToken,
} from './auth'
import {
  clampLimit,
  clampOffset,
  decodePeriodActivityCursor,
  decodeRecentActivityCursor,
  normalizeMode,
  normalizeSource,
  normalizeSources,
  parseTimestamp,
  ReadStoreError,
} from './read_store'
import { withFederatedReadStore } from './read_store/federated'

export interface ApiServerOptions {
  dbPath?: string
  bind?: string
  port?: number
  auth?: {
    enabled?: boolean
    store?: ApiAuthStore
    token?: string
  }
}

export interface ApiRuntimeAuth {
  enabled: boolean
  store: ApiAuthStore
  token?: string
}

// Encodes a search query into an embedding, or undefined when semantic search
// is unavailable (no engine configured/built, model not loaded, etc.) so the
// read store transparently falls back to FTS5.
type QueryEncoder = (text: string) => Promise<Float32Array | undefined>

// Owns a single warm embedding worker for the lifetime of the API server.
// `warm()` kicks off the engine at server boot so the first query doesn't pay
// the model-load cost; a failed attempt clears the cached promise so a later
// request retries instead of disabling semantic search for the whole session.
function makeQueryEncoder(): {
  encode: QueryEncoder
  warm: () => void
  stop: () => Promise<void>
} {
  let engine: EmbeddingEngine | undefined
  let startup: Promise<boolean> | undefined

  async function ensure(): Promise<boolean> {
    if (startup) return startup
    const attempt = (async () => {
      try {
        const cfg = loadConfig()
        const candidate = makeEmbedding(cfg.processing.embeddings)
        if (candidate.dim <= 0 || !(await candidate.ready())) return false
        await candidate.start({ onStatus: () => {} })
        engine = candidate
        return true
      } catch (err) {
        console.error(`[hyprmnesia:api] semantic search unavailable: ${String(err)}`)
        return false
      }
    })()
    startup = attempt
    const ok = await attempt
    if (!ok) startup = undefined
    return ok
  }

  return {
    async encode(text) {
      if (!(await ensure()) || !engine) return undefined
      try {
        const [result] = await engine.embed([{ id: 'query', kind: 'query', text }])
        return result?.vector
      } catch {
        return undefined
      }
    },
    warm() {
      void ensure().catch(() => undefined)
    },
    async stop() {
      await engine?.stop().catch(() => {})
    },
  }
}

// Turns URLSearchParams into a plain record so the existing arg-coercion
// helpers (shared with the old tool-call dispatch) work unchanged. `sources`
// is comma-separated in the query string but the helpers expect an array.
function queryRecord(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of url.searchParams) out[key] = value
  if (typeof out['sources'] === 'string') {
    out['sources'] = (out['sources'] as string).split(',').filter((s) => s !== '')
  }
  return out
}

async function handleSearch(dbPath: string, url: URL, encodeQuery: QueryEncoder): Promise<unknown> {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'search', [
    'query',
    'from',
    'to',
    'source',
    'app',
    'mode',
    'limit',
    'offset',
  ])
  const query = stringArg(args, 'query')
  const from = parseTimestamp(args['from'], 'from')
  const to = parseTimestamp(args['to'], 'to')
  validateRange(from, to)
  const source = normalizeSource(args['source'])
  const mode = normalizeMode(args['mode'])
  const queryVector = mode === 'lexical' ? undefined : await encodeQuery(query)
  const results = withFederatedReadStore(dbPath, (store) =>
    store.search(query, {
      from,
      to,
      source,
      app: typeof args['app'] === 'string' ? args['app'] : undefined,
      mode,
      queryVector,
      limit: clampLimit(args['limit']),
      offset: clampOffset(args['offset']),
    }),
  )
  return { results, count: results.length }
}

function handleRecentActivity(dbPath: string, url: URL): unknown {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'recent_activity', [
    'minutes',
    'to',
    'sources',
    'app',
    'include_empty',
    'limit',
    'cursor',
  ])
  const to = parseTimestamp(args['to'], 'to') ?? Date.now()
  const minutes = numberArg(args['minutes'], 5, 0.1, 1440)
  const from = to - Math.round(minutes * 60_000)
  const result = withFederatedReadStore(dbPath, (store) =>
    store.recentActivity({
      from,
      to,
      sources: normalizeSources(args['sources']),
      app: typeof args['app'] === 'string' ? args['app'] : undefined,
      includeEmpty: boolArg(args['include_empty'], false),
      limit: clampLimit(args['limit'], 50),
      beforeAt: decodeRecentActivityCursor(args['cursor'])?.before_at,
    }),
  )
  return {
    groups: result.groups,
    count: result.groups.length,
    from,
    to,
    minutes,
    truncated: result.truncated,
    next_cursor: result.next_cursor,
  }
}

function handlePeriodActivity(dbPath: string, url: URL): unknown {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'period_activity', [
    'from',
    'to',
    'granularity',
    'sources',
    'app',
    'cursor',
    'limit',
  ])
  const from = parseTimestamp(args['from'], 'from')
  const to = parseTimestamp(args['to'], 'to')
  if (from === undefined || to === undefined) throw new ReadStoreError('from and to are required')
  validateRange(from, to)
  const granularity = args['granularity']
  if (granularity !== undefined && granularity !== 'day') {
    throw new ReadStoreError('granularity must be day')
  }
  return withFederatedReadStore(dbPath, (store) =>
    store.periodActivity({
      from,
      to,
      sources: normalizeSources(args['sources']),
      app: typeof args['app'] === 'string' ? args['app'] : undefined,
      limit: Math.min(50, clampLimit(args['limit'], 20)),
      cursor: decodePeriodActivityCursor(args['cursor']),
    }),
  )
}

function handleTimeline(dbPath: string, url: URL): unknown {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'timeline', [
    'from',
    'to',
    'source',
    'app',
    'include_empty',
    'limit',
    'offset',
  ])
  const from = parseTimestamp(args['from'], 'from')
  const to = parseTimestamp(args['to'], 'to')
  if (from === undefined || to === undefined) throw new ReadStoreError('from and to are required')
  validateRange(from, to)
  const source = normalizeSource(args['source'])
  const items = withFederatedReadStore(dbPath, (store) =>
    store.timeline({
      from,
      to,
      source,
      app: typeof args['app'] === 'string' ? args['app'] : undefined,
      includeEmpty: boolArg(args['include_empty'], false),
      limit: clampLimit(args['limit']),
      offset: clampOffset(args['offset']),
    }),
  )
  return { items, count: items.length }
}

function handleRecall(dbPath: string, id: string, url: URL): unknown {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'recall', ['include_blob'])
  return withFederatedReadStore(dbPath, (store) =>
    store.recall(id, boolArg(args['include_blob'], false)),
  )
}

function handleTranscriptSegment(dbPath: string, id: string, url: URL): unknown {
  const args = queryRecord(url)
  rejectUnknownArgs(args, 'transcript_segment', ['include_chunk'])
  return withFederatedReadStore(dbPath, (store) =>
    store.getTranscriptSegment(id, boolArg(args['include_chunk'], true)),
  )
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

function errorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  const status = err instanceof ReadStoreError ? 400 : 500
  return jsonError(status, message)
}

function authError(auth: ApiRuntimeAuth, token: string | undefined): Response | undefined {
  if (!auth.enabled) return undefined
  const result = verifyApiToken(token, auth.store)
  if (result === true) return undefined
  return jsonError(401, apiAuthFailureMessage(result))
}

export function apiAuthStartupWarnings(auth: ApiRuntimeAuth): string[] {
  if (!auth.enabled) return ['API auth is disabled; requests are unprotected.']
  if (!isApiAuthConfigured(auth.store)) {
    return ['API auth token is not configured. Run `hpm api auth setup` before calling the API.']
  }
  return []
}

function logApiAuthStartupWarnings(auth: ApiRuntimeAuth): void {
  for (const warning of apiAuthStartupWarnings(auth)) {
    console.error(`[hyprmnesia:api] warning: ${warning}`)
  }
}

function tokenFromRequest(req: Request): string | undefined {
  const authorization = req.headers.get('authorization')?.trim()
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return bearer
  const header = req.headers.get('x-hyprmnesia-api-token')?.trim()
  return header === '' ? undefined : header
}

function isLocalBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1' || bind === '[::1]'
}

// Routes one request. Returns undefined for an unmatched path so the caller
// can 404; throws ReadStoreError (-> 400) or any other error (-> 500).
async function route(
  req: Request,
  url: URL,
  dbPath: string,
  encodeQuery: QueryEncoder,
): Promise<unknown | undefined> {
  if (req.method !== 'GET') return undefined
  if (url.pathname === '/search') return handleSearch(dbPath, url, encodeQuery)
  if (url.pathname === '/recent-activity') return handleRecentActivity(dbPath, url)
  if (url.pathname === '/period-activity') return handlePeriodActivity(dbPath, url)
  if (url.pathname === '/timeline') return handleTimeline(dbPath, url)
  const recall = url.pathname.match(/^\/recall\/(.+)$/)
  if (recall?.[1]) return handleRecall(dbPath, decodeURIComponent(recall[1]), url)
  const segment = url.pathname.match(/^\/transcript-segment\/(.+)$/)
  if (segment?.[1]) return handleTranscriptSegment(dbPath, decodeURIComponent(segment[1]), url)
  return undefined
}

// Builds the request handler on its own, with no port binding, so tests can
// exercise it via plain fetch() calls without a real network listener.
export function createApiFetchHandler(
  dbPath: string,
  encodeQuery: QueryEncoder,
  auth: ApiRuntimeAuth,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, name: 'hyprmnesia', version: VERSION })
    }
    const denied = authError(auth, tokenFromRequest(req))
    if (denied) return denied
    try {
      const result = await route(req, url, dbPath, encodeQuery)
      if (result === undefined) return new Response('not found', { status: 404 })
      return Response.json(result)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<void> {
  const dbPath = expandHome(options.dbPath ?? defaultDbPath())
  const bind = options.bind ?? '127.0.0.1'
  const port = options.port ?? 37373
  const auth: ApiRuntimeAuth = {
    enabled: options.auth?.enabled ?? true,
    store: options.auth?.store ?? createDefaultApiAuthStore(),
    token: options.auth?.token,
  }
  logApiAuthStartupWarnings(auth)

  if (!isLocalBind(bind)) {
    throw new Error(`refusing non-local API bind ${bind}; network exposure is not supported yet`)
  }

  const encoder = makeQueryEncoder()
  encoder.warm()
  const fetch = createApiFetchHandler(dbPath, encoder.encode, auth)

  const server = Bun.serve({ hostname: bind, port, fetch })
  console.error(
    `[hyprmnesia:api] read-only REST API listening on http://${bind}:${server.port}; db=${dbPath}`,
  )

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }).finally(() => encoder.stop())
}
