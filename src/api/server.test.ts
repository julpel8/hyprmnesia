import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { openChunkStore } from '../store/db'
import { hashApiToken, MemoryApiAuthStore } from './auth'
import { type ApiRuntimeAuth, apiAuthStartupWarnings, createApiFetchHandler } from './server'

const dirs: string[] = []

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-api-server-'))
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

function authWithToken(token?: string): ApiRuntimeAuth {
  const store = new MemoryApiAuthStore()
  if (token) store.write(hashApiToken(token))
  return { enabled: true, store, token }
}

function noAuth(): ApiRuntimeAuth {
  return { enabled: false, store: new MemoryApiAuthStore() }
}

function fetchAs(
  dbPath: string,
  auth: ApiRuntimeAuth,
  path: string,
  token?: string,
): Promise<Response> {
  const handler = createApiFetchHandler(dbPath, async () => undefined, auth)
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  return handler(new Request(`http://127.0.0.1${path}`, { headers }))
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

test('health works without auth', async () => {
  const res = await fetchAs('missing.db', authWithToken(), '/health')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok?: boolean; name?: string }
  expect(body.ok).toBe(true)
  expect(body.name).toBe('hyprmnesia')
})

test('unauthorized search returns 401 before opening the database', async () => {
  const res = await fetchAs('definitely-missing.db', authWithToken(), '/search?query=invoice')
  expect(res.status).toBe(401)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('API auth token missing')
})

test('authorized search reaches the normal read path', async () => {
  const token = 'hpm_api_test-token'
  const dbPath = freshDb()
  const res = await fetchAs(dbPath, authWithToken(token), '/search?query=invoice', token)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { count?: number }
  expect(body.count).toBeGreaterThan(0)
})

test('disabled auth allows search without a token', async () => {
  const dbPath = freshDb()
  const res = await fetchAs(dbPath, noAuth(), '/search?query=invoice')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { count?: number }
  expect(body.count).toBeGreaterThan(0)
})

test('recent-activity reports truncation state and accepts a cursor', async () => {
  const dbPath = freshDb()
  const auth = noAuth()
  const res = await fetchAs(dbPath, auth, '/recent-activity?minutes=10')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { truncated?: boolean; next_cursor?: string | null }
  expect(body.truncated).toBe(false)
  expect(body.next_cursor).toBeNull()

  const bad = await fetchAs(dbPath, auth, '/recent-activity?cursor=garbage')
  expect(bad.status).toBe(400)
  const badBody = (await bad.json()) as { error?: string }
  expect(badBody.error).toContain('invalid cursor')
})

test('period-activity returns sessions and day aggregates over the seeded chunk', async () => {
  const dbPath = freshDb()
  const now = Date.now()
  const res = await fetchAs(
    dbPath,
    noAuth(),
    `/period-activity?from=${now - 3_600_000}&to=${now + 1_000}`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    sessions?: unknown[]
    days?: Array<{ sessions: number }>
    truncated?: boolean
    total_sessions?: number
  }
  expect(body.sessions?.length).toBe(1)
  expect(body.days?.length).toBeGreaterThan(0)
  expect(body.truncated).toBe(false)
  expect(body.total_sessions).toBe(1)
})

test('period-activity rejects unknown arguments', async () => {
  const dbPath = freshDb()
  const res = await fetchAs(dbPath, noAuth(), '/period-activity?from=0&to=1&bogus=true')
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('bogus')
})

test('apiAuthStartupWarnings explain missing setup', () => {
  expect(apiAuthStartupWarnings(authWithToken())).toEqual([
    'API auth token is not configured. Run `hpm api auth setup` before calling the API.',
  ])
})

test('apiAuthStartupWarnings stay quiet when auth is configured', () => {
  const token = 'hpm_api_test-token'
  expect(apiAuthStartupWarnings(authWithToken(token))).toEqual([])
})

test('apiAuthStartupWarnings flag disabled auth', () => {
  expect(apiAuthStartupWarnings(noAuth())).toEqual([
    'API auth is disabled; requests are unprotected.',
  ])
})
