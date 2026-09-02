import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from '../store/db'
import { hashMcpToken, MemoryMcpAuthStore } from './auth'
import { handleMessage, type McpRuntimeAuth, mcpAuthStartupWarnings } from './server'

const dirs: string[] = []

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-mcp-server-'))
  dirs.push(dir)
  const dbPath = join(dir, 'index.db')
  const store = openChunkStore(dbPath)
  store.insert({
    id: randomUUIDv7(),
    kind: 'screenshot',
    at: Date.now(),
    blob: join(dir, 'screen.png'),
    bytes: 10,
    text: 'quarterly invoice dashboard',
    capture_ms: 1,
  })
  store.close()
  return dbPath
}

function authWithToken(token?: string): McpRuntimeAuth {
  const store = new MemoryMcpAuthStore()
  if (token) store.write(hashMcpToken(token))
  return { enabled: true, store, token }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (attempt === 9) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
})

test('initialize and tools/list work without auth', async () => {
  const auth = authWithToken()
  const initialize = await handleMessage(
    'missing.db',
    { id: 1, method: 'initialize', params: {} },
    async () => undefined,
    auth,
  )
  expect(initialize?.error).toBeUndefined()
  expect((initialize?.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
    'hyprmnesia',
  )

  const tools = await handleMessage(
    'missing.db',
    { id: 2, method: 'tools/list' },
    async () => undefined,
    auth,
  )
  expect(tools?.error).toBeUndefined()
  expect(((tools?.result as { tools?: unknown[] }).tools ?? []).length).toBeGreaterThan(0)
})

test('unauthorized tools/call returns a tool error before opening the database', async () => {
  const response = await handleMessage(
    'definitely-missing.db',
    { id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'invoice' } } },
    async () => {
      throw new Error('encoder should not run before auth')
    },
    authWithToken(),
  )
  const result = response?.result as { isError?: boolean; content?: Array<{ text: string }> }
  expect(result.isError).toBe(true)
  expect(result.content?.[0]?.text).toContain('MCP auth token missing')
})

test('authorized tools/call reaches the normal read path', async () => {
  const token = 'hpm_mcp_test-token'
  const dbPath = freshDb()
  const response = await handleMessage(
    dbPath,
    { id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'invoice' } } },
    async () => undefined,
    authWithToken(token),
  )
  const result = response?.result as { isError?: boolean; structuredContent?: { count?: number } }
  expect(result.isError).toBeUndefined()
  expect(result.structuredContent?.count).toBeGreaterThan(0)
})

test('disabled auth allows tools/call without a token', async () => {
  const dbPath = freshDb()
  const response = await handleMessage(
    dbPath,
    { id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'invoice' } } },
    async () => undefined,
    { enabled: false, store: new MemoryMcpAuthStore() },
  )
  const result = response?.result as { isError?: boolean; structuredContent?: { count?: number } }
  expect(result.isError).toBeUndefined()
  expect(result.structuredContent?.count).toBeGreaterThan(0)
})

test('tools/list exposes period_activity', async () => {
  const tools = await handleMessage(
    'missing.db',
    { id: 1, method: 'tools/list' },
    async () => undefined,
    authWithToken(),
  )
  const names = ((tools?.result as { tools?: Array<{ name: string }> }).tools ?? []).map(
    (tool) => tool.name,
  )
  expect(names).toContain('period_activity')
  expect(names).toContain('recent_activity')
})

test('recent_activity reports truncation state and accepts a cursor', async () => {
  const dbPath = freshDb()
  const auth = { enabled: false, store: new MemoryMcpAuthStore() }
  const response = await handleMessage(
    dbPath,
    {
      id: 1,
      method: 'tools/call',
      params: { name: 'recent_activity', arguments: { minutes: 10 } },
    },
    async () => undefined,
    auth,
  )
  const result = response?.result as {
    isError?: boolean
    structuredContent?: { truncated?: boolean; next_cursor?: string | null; count?: number }
  }
  expect(result.isError).toBeUndefined()
  expect(result.structuredContent?.truncated).toBe(false)
  expect(result.structuredContent?.next_cursor).toBeNull()

  const bad = await handleMessage(
    dbPath,
    {
      id: 2,
      method: 'tools/call',
      params: { name: 'recent_activity', arguments: { cursor: 'garbage' } },
    },
    async () => undefined,
    auth,
  )
  const badResult = bad?.result as { isError?: boolean; content?: Array<{ text: string }> }
  expect(badResult.isError).toBe(true)
  expect(badResult.content?.[0]?.text).toContain('invalid cursor')
})

test('period_activity returns sessions and day aggregates over the seeded chunk', async () => {
  const dbPath = freshDb()
  const now = Date.now()
  const response = await handleMessage(
    dbPath,
    {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'period_activity',
        arguments: { from: now - 3_600_000, to: now + 1_000 },
      },
    },
    async () => undefined,
    { enabled: false, store: new MemoryMcpAuthStore() },
  )
  const result = response?.result as {
    isError?: boolean
    structuredContent?: {
      sessions?: unknown[]
      days?: Array<{ sessions: number }>
      truncated?: boolean
      total_sessions?: number
    }
  }
  expect(result.isError).toBeUndefined()
  expect(result.structuredContent?.sessions?.length).toBe(1)
  expect(result.structuredContent?.days?.length).toBeGreaterThan(0)
  expect(result.structuredContent?.truncated).toBe(false)
  expect(result.structuredContent?.total_sessions).toBe(1)
})

test('period_activity rejects unknown arguments', async () => {
  const dbPath = freshDb()
  const response = await handleMessage(
    dbPath,
    {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'period_activity',
        arguments: { from: 0, to: 1, bogus: true },
      },
    },
    async () => undefined,
    { enabled: false, store: new MemoryMcpAuthStore() },
  )
  const result = response?.result as { isError?: boolean; content?: Array<{ text: string }> }
  expect(result.isError).toBe(true)
  expect(result.content?.[0]?.text).toContain('bogus')
})

test('mcpAuthStartupWarnings explain missing setup and missing stdio token', () => {
  expect(mcpAuthStartupWarnings(authWithToken(), 'stdio')).toEqual([
    'MCP auth token is not configured. Run `hpm mcp auth setup` before using tools/call.',
  ])

  const token = 'hpm_mcp_test-token'
  const configured = authWithToken(token)
  configured.token = undefined
  expect(mcpAuthStartupWarnings(configured, 'stdio')).toEqual([
    'HPM_MCP_TOKEN is not set; stdio tools/call requests will be refused.',
  ])
})

test('mcpAuthStartupWarnings stay quiet for HTTP when auth is configured', () => {
  const token = 'hpm_mcp_test-token'
  expect(mcpAuthStartupWarnings(authWithToken(token), 'http')).toEqual([])
})
