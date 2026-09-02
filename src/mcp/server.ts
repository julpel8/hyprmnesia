import { loadConfig } from '../config'
import { makeEmbedding } from '../process/embeddings'
import type { EmbeddingEngine } from '../process/types'
import { defaultDbPath, expandHome } from '../util/paths'
import { VERSION } from '../version'
import { asRecord, boolArg, numberArg, rejectUnknownArgs, stringArg, validateRange } from './args'
import {
  createDefaultMcpAuthStore,
  isMcpAuthConfigured,
  type McpAuthFailure,
  type McpAuthStore,
  mcpAuthFailureMessage,
  verifyMcpToken,
} from './auth'
import { type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, StdioJsonRpc } from './protocol'
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
import {
  linesForPeriodActivity,
  linesForRecentActivity,
  linesForSearch,
  linesForTimeline,
} from './tool_output'

const PROTOCOL_VERSION = '2025-06-18'
const TOOLS = [
  {
    name: 'search',
    description:
      'Search OCR text, active window context, and transcript segments in the local Hyprmnesia index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Plain text query. Terms are ANDed for FTS5 search.',
        },
        from: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Optional ISO date or epoch-ms lower bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Optional ISO date or epoch-ms upper bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        source: {
          type: 'string',
          enum: ['screen', 'mic', 'system'],
          description: 'Optional source filter.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        mode: {
          type: 'string',
          enum: ['lexical', 'semantic', 'hybrid'],
          description:
            'Retrieval mode. Default hybrid (FTS5 + semantic, fused). Falls back to lexical when the semantic index is unavailable.',
        },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Default 20, max 100.' },
        offset: { type: 'number', minimum: 0, description: 'Pagination offset.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'recent_activity',
    description:
      'Group recent screen, mic, and system audio captures into human-readable activity windows.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          minimum: 0.1,
          maximum: 1440,
          description: 'Look back this many minutes from "to". Default 5.',
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Optional ISO date or epoch-ms upper bound. Defaults to now. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['screen', 'mic', 'system'] },
          description: 'Sources to include. Default screen, mic, and system.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        include_empty: {
          type: 'boolean',
          description: 'Default false. Include chunks with no text and no transcript segment.',
        },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Default 50, max 100.' },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a previous response (next_cursor). Returns older groups.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'period_activity',
    description:
      'Deterministic multi-day activity report: sessions (contiguous time + window + source) with ' +
      'estimated active durations, counts, representative excerpts linked to chunk/segment ids, ' +
      'directly observable project context, and per-day aggregates. Paginate with cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms lower bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms upper bound. Range must span at most 31 days. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        granularity: {
          type: 'string',
          enum: ['day'],
          description: 'Aggregation granularity. Only day is supported.',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['screen', 'mic', 'system'] },
          description: 'Sources to include. Default screen, mic, and system.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from a previous response (next_cursor).',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Sessions per page. Default 20, max 50.',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'timeline',
    description:
      'List captured chunks in chronological order for a time range. Results include both local_* and utc_* timestamps; use local_* when answering the user.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms lower bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms upper bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        source: {
          type: 'string',
          enum: ['screen', 'mic', 'system'],
          description: 'Optional source filter.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        include_empty: {
          type: 'boolean',
          description: 'Default false. Include chunks with no text and no transcript segment.',
        },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Default 20, max 100.' },
        offset: { type: 'number', minimum: 0, description: 'Pagination offset.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description:
      'Fetch one captured chunk by id, including linked transcript segments. Blob paths are opt-in.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Chunk id.' },
        include_blob: {
          type: 'boolean',
          description: 'When true, include local blob_path and mime_type.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_transcript_segment',
    description:
      'Fetch one transcript segment by id, optionally including its parent chunk summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Transcript segment id.' },
        include_chunk: { type: 'boolean', description: 'Default true.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

export interface McpServerOptions {
  dbPath?: string
  transport?: 'stdio' | 'http'
  bind?: string
  port?: number
  auth?: {
    enabled?: boolean
    store?: McpAuthStore
    token?: string
  }
}

export interface McpRuntimeAuth {
  enabled: boolean
  store: McpAuthStore
  token?: string
}

type McpTransport = 'stdio' | 'http'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

// Encodes a search query into an embedding, or undefined when semantic search
// is unavailable (no engine configured/built, model not loaded, etc.) so the
// read store transparently falls back to FTS5.
type QueryEncoder = (text: string) => Promise<Float32Array | undefined>

// Owns a single warm embedding worker for the lifetime of the MCP server.
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
        console.error(`[hyprmnesia:mcp] semantic search unavailable: ${String(err)}`)
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

async function callTool(
  dbPath: string,
  name: string,
  rawArgs: unknown,
  encodeQuery: QueryEncoder,
): Promise<ToolResult> {
  const args = asRecord(rawArgs)
  if (name === 'search') {
    rejectUnknownArgs(args, name, [
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
    return {
      content: [{ type: 'text', text: linesForSearch(results) }],
      structuredContent: { results, count: results.length },
    }
  }

  if (name === 'recent_activity') {
    rejectUnknownArgs(args, name, [
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
      content: [{ type: 'text', text: linesForRecentActivity(result.groups) }],
      structuredContent: {
        groups: result.groups,
        count: result.groups.length,
        from,
        to,
        minutes,
        truncated: result.truncated,
        next_cursor: result.next_cursor,
      },
    }
  }

  if (name === 'period_activity') {
    rejectUnknownArgs(args, name, [
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
    const result = withFederatedReadStore(dbPath, (store) =>
      store.periodActivity({
        from,
        to,
        sources: normalizeSources(args['sources']),
        app: typeof args['app'] === 'string' ? args['app'] : undefined,
        limit: Math.min(50, clampLimit(args['limit'], 20)),
        cursor: decodePeriodActivityCursor(args['cursor']),
      }),
    )
    return {
      content: [{ type: 'text', text: linesForPeriodActivity(result) }],
      structuredContent: result,
    }
  }

  if (name === 'timeline') {
    rejectUnknownArgs(args, name, [
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
    return {
      content: [{ type: 'text', text: linesForTimeline(items) }],
      structuredContent: { items, count: items.length },
    }
  }

  if (name === 'recall') {
    rejectUnknownArgs(args, name, ['id', 'include_blob'])
    const id = stringArg(args, 'id')
    const result = withFederatedReadStore(dbPath, (store) =>
      store.recall(id, boolArg(args['include_blob'], false)),
    )
    const text =
      result.found && result.chunk
        ? `Chunk ${id}: ${result.chunk.text || '(no text)'}`
        : `Chunk not found: ${id}`
    return { content: [{ type: 'text', text }], structuredContent: result }
  }

  if (name === 'get_transcript_segment') {
    rejectUnknownArgs(args, name, ['id', 'include_chunk'])
    const id = stringArg(args, 'id')
    const result = withFederatedReadStore(dbPath, (store) =>
      store.getTranscriptSegment(id, boolArg(args['include_chunk'], true)),
    )
    const text =
      result.found && result.segment
        ? `Transcript segment ${id}: ${result.segment.text || '(no text)'}`
        : `Transcript segment not found: ${id}`
    return { content: [{ type: 'text', text }], structuredContent: result }
  }

  throw new ReadStoreError(`unknown tool: ${name}`)
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function authToolError(auth: McpRuntimeAuth): ToolResult | undefined {
  if (!auth.enabled) return undefined
  const result = verifyMcpToken(auth.token, auth.store)
  if (result === true) return undefined
  return {
    content: [{ type: 'text', text: mcpAuthFailureMessage(result) }],
    isError: true,
  }
}

export function mcpAuthStartupWarnings(auth: McpRuntimeAuth, transport: McpTransport): string[] {
  if (!auth.enabled) return ['MCP auth is disabled; tools/call is unprotected.']
  if (!isMcpAuthConfigured(auth.store)) {
    return ['MCP auth token is not configured. Run `hpm mcp auth setup` before using tools/call.']
  }
  if (transport !== 'stdio') return []
  if (!auth.token) return ['HPM_MCP_TOKEN is not set; stdio tools/call requests will be refused.']
  const result = verifyMcpToken(auth.token, auth.store)
  if (result === true) return []
  return [
    `HPM_MCP_TOKEN is ${authFailureLabel(result)}; stdio tools/call requests will be refused.`,
  ]
}

function logMcpAuthStartupWarnings(auth: McpRuntimeAuth, transport: McpTransport): void {
  for (const warning of mcpAuthStartupWarnings(auth, transport)) {
    console.error(`[hyprmnesia:mcp] warning: ${warning}`)
  }
}

function authFailureLabel(reason: McpAuthFailure): string {
  if (reason === 'missing_token') return 'missing'
  if (reason === 'unconfigured') return 'not configured'
  return 'invalid'
}

function protocolResult(method: string, params: unknown): unknown {
  if (method === 'initialize') {
    const requested = asRecord(params)['protocolVersion']
    return {
      protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'hyprmnesia',
        version: VERSION,
      },
      instructions:
        'Hyprmnesia MCP is local and read-only. Use recent_activity for what-was-I-doing questions, period_activity for multi-day summaries (sessions, durations, per-day aggregates; paginate with cursor), search for text lookup, timeline for exact time windows, recall for chunk details, and get_transcript_segment for precise transcript segments. Results include UTC and local timestamps; use local_* timestamps when answering the user.',
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'resources/list') return { resources: [] }
  if (method === 'prompts/list') return { prompts: [] }
  if (method === 'ping' || method === 'logging/setLevel') return {}
  return undefined
}

export async function handleMessage(
  dbPath: string,
  message: JsonRpcRequest,
  encodeQuery: QueryEncoder,
  auth: McpRuntimeAuth,
): Promise<JsonRpcResponse | undefined> {
  const hasId = Object.hasOwn(message, 'id')
  const id = hasId ? (message.id ?? null) : null
  if (!message.method) {
    if (hasId) return failure(id, -32600, 'Invalid Request')
    return undefined
  }

  const staticResult = protocolResult(message.method, message.params)
  if (staticResult !== undefined) return hasId ? success(id, staticResult) : undefined

  if (message.method === 'tools/call') {
    if (!hasId) return undefined
    const params = asRecord(message.params)
    const name = params['name']
    if (typeof name !== 'string') return failure(id, -32602, 'tools/call requires params.name')
    const authError = authToolError(auth)
    if (authError) return success(id, authError)
    try {
      return success(id, await callTool(dbPath, name, params['arguments'], encodeQuery))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return success(id, { content: [{ type: 'text', text: message }], isError: true })
    }
  }

  return hasId ? failure(id, -32601, `Method not found: ${message.method}`) : undefined
}

function isLocalBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1' || bind === '[::1]'
}

async function startStdioMcpServer(
  dbPath: string,
  encodeQuery: QueryEncoder,
  auth: McpRuntimeAuth,
): Promise<void> {
  console.error(
    `[hyprmnesia:mcp] starting read-only MCP server; transport=stdio; db=${dbPath}; tools=${TOOLS.length}`,
  )

  let rpc: StdioJsonRpc
  rpc = new StdioJsonRpc((message: JsonRpcRequest) => {
    void handleMessage(dbPath, message, encodeQuery, auth).then((response) => {
      if (response) rpc.send(response)
    })
  })

  await rpc.start()
}

async function startHttpMcpServer(
  dbPath: string,
  bind: string,
  port: number,
  encodeQuery: QueryEncoder,
  auth: McpRuntimeAuth,
): Promise<void> {
  if (!isLocalBind(bind)) {
    throw new Error(
      `refusing non-local MCP bind ${bind}; network MCP exposure is not supported yet`,
    )
  }

  const server = Bun.serve({
    hostname: bind,
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, name: 'hyprmnesia', transport: 'http' })
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 })
      }
      let body: unknown
      try {
        body = await req.json()
      } catch (err) {
        return Response.json(failure(null, -32700, 'Parse error', String(err)), { status: 400 })
      }
      const batch = Array.isArray(body)
      const messages = (batch ? body : [body]) as JsonRpcRequest[]
      const requestAuth = { ...auth, token: tokenFromHttpRequest(req) }
      const responses = (
        await Promise.all(
          messages.map((message) => handleMessage(dbPath, message, encodeQuery, requestAuth)),
        )
      ).filter((response): response is JsonRpcResponse => response !== undefined)
      if (responses.length === 0) return new Response(null, { status: 202 })
      return Response.json(batch ? responses : responses[0], {
        headers: { 'MCP-Protocol-Version': PROTOCOL_VERSION },
      })
    },
  })
  console.error(
    `[hyprmnesia:mcp] starting read-only MCP server; transport=http; url=http://${bind}:${server.port}/mcp; db=${dbPath}; tools=${TOOLS.length}`,
  )

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function tokenFromHttpRequest(req: Request): string | undefined {
  const authorization = req.headers.get('authorization')?.trim()
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) return bearer
  const header = req.headers.get('x-hyprmnesia-mcp-token')?.trim()
  return header === '' ? undefined : header
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const dbPath = expandHome(options.dbPath ?? defaultDbPath())
  const transport = options.transport ?? 'stdio'
  const bind = options.bind ?? '127.0.0.1'
  const port = options.port ?? 37373
  const auth: McpRuntimeAuth = {
    enabled: options.auth?.enabled ?? true,
    store: options.auth?.store ?? createDefaultMcpAuthStore(),
    token: options.auth?.token ?? process.env.HPM_MCP_TOKEN,
  }
  logMcpAuthStartupWarnings(auth, transport)

  const encoder = makeQueryEncoder()
  encoder.warm()
  try {
    if (transport === 'stdio') {
      await startStdioMcpServer(dbPath, encoder.encode, auth)
      return
    }
    if (transport === 'http') {
      await startHttpMcpServer(dbPath, bind, port, encoder.encode, auth)
      return
    }
    throw new Error(`unsupported MCP transport: ${String(transport)}`)
  } finally {
    await encoder.stop()
  }
}
