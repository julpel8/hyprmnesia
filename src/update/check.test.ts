import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkForUpdate,
  compareSemver,
  envOptOut,
  formatUpdateNotice,
  isNewerVersion,
} from './check'

const dirs: string[] = []

function tmpCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-update-'))
  dirs.push(dir)
  return join(dir, 'update-check.json')
}

interface FakeResponse {
  status: number
  ok: boolean
  json(): Promise<unknown>
  headers: { get(name: string): string | null }
}

function jsonResponse(body: unknown, etag?: string): FakeResponse {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'etag' && etag ? etag : null) },
  }
}

function statusResponse(status: number): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
    headers: { get: () => null },
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.HPM_NO_UPDATE_CHECK
  delete process.env.CI
})

test('compareSemver orders core versions and prereleases', () => {
  expect(compareSemver('0.5.0', '0.4.1')).toBe(1)
  expect(compareSemver('0.4.1', '0.5.0')).toBe(-1)
  expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  // A final release outranks the same core version's prerelease.
  expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
  // Build metadata does not affect ordering.
  expect(compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
  // Unparseable input never claims an update.
  expect(compareSemver('not-a-version', '1.0.0')).toBe(0)
  expect(compareSemver('1.0.0oops', '0.9.0')).toBe(0)
})

test('isNewerVersion is true only for a strictly greater release', () => {
  expect(isNewerVersion('0.5.0', '0.4.1')).toBe(true)
  expect(isNewerVersion('0.4.1', '0.4.1')).toBe(false)
  expect(isNewerVersion('0.4.0', '0.4.1')).toBe(false)
})

test('envOptOut respects HPM_NO_UPDATE_CHECK and CI', () => {
  expect(envOptOut()).toBe(false)
  process.env.HPM_NO_UPDATE_CHECK = '1'
  expect(envOptOut()).toBe(true)
  process.env.HPM_NO_UPDATE_CHECK = '0'
  expect(envOptOut()).toBe(false)
  process.env.CI = 'true'
  expect(envOptOut()).toBe(true)
})

test('checkForUpdate reports an available update and writes the cache', async () => {
  const cachePath = tmpCachePath()
  let calls = 0
  const status = await checkForUpdate({
    cachePath,
    currentVersion: '0.4.1',
    fetchImpl: async () => {
      calls++
      return jsonResponse(
        {
          tag_name: 'v0.5.0',
          html_url: 'https://github.com/hyprmnesia/hyprmnesia/releases/tag/v0.5.0',
        },
        '"etag-123"',
      )
    },
  })

  expect(calls).toBe(1)
  expect(status.updateAvailable).toBe(true)
  expect(status.latestVersion).toBe('0.5.0')
  expect(status.source).toBe('network')
  expect(existsSync(cachePath)).toBe(true)
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
  expect(cached.latestVersion).toBe('0.5.0')
  expect(cached.etag).toBe('"etag-123"')
})

test('checkForUpdate serves a fresh cache without hitting the network', async () => {
  const cachePath = tmpCachePath()
  const now = 1_000_000_000_000
  writeFileSync(
    cachePath,
    JSON.stringify({ checkedAt: now, latestVersion: '0.5.0', releaseUrl: 'https://example/r' }),
  )
  const status = await checkForUpdate({
    cachePath,
    currentVersion: '0.4.1',
    now: now + 1000,
    fetchImpl: async () => {
      throw new Error('network must not be used for a fresh cache')
    },
  })

  expect(status.source).toBe('cache')
  expect(status.updateAvailable).toBe(true)
  expect(status.latestVersion).toBe('0.5.0')
})

test('force bypasses a fresh cache', async () => {
  const cachePath = tmpCachePath()
  const now = 1_000_000_000_000
  writeFileSync(
    cachePath,
    JSON.stringify({ checkedAt: now, latestVersion: '0.5.0', releaseUrl: null }),
  )
  let calls = 0
  await checkForUpdate({
    cachePath,
    currentVersion: '0.4.1',
    now: now + 1000,
    force: true,
    fetchImpl: async () => {
      calls++
      return jsonResponse({ tag_name: 'v0.6.0', html_url: 'https://example/r6' })
    },
  })
  expect(calls).toBe(1)
})

test('a 304 response refreshes the timestamp and keeps the cached version', async () => {
  const cachePath = tmpCachePath()
  const old = 1_000
  writeFileSync(
    cachePath,
    JSON.stringify({
      checkedAt: old,
      latestVersion: '0.5.0',
      releaseUrl: 'https://r',
      etag: '"e1"',
    }),
  )
  let sentIfNoneMatch: string | undefined
  const now = old + 10 * 24 * 60 * 60 * 1000
  const status = await checkForUpdate({
    cachePath,
    currentVersion: '0.4.1',
    now,
    fetchImpl: async (_url, init) => {
      sentIfNoneMatch = init.headers['If-None-Match']
      return statusResponse(304)
    },
  })

  expect(sentIfNoneMatch).toBe('"e1"')
  expect(status.source).toBe('not-modified')
  expect(status.latestVersion).toBe('0.5.0')
  expect(status.checkedAt).toBe(now)
})

test('an unreachable network falls back to the stale cache', async () => {
  const cachePath = tmpCachePath()
  const old = 1_000
  writeFileSync(
    cachePath,
    JSON.stringify({ checkedAt: old, latestVersion: '0.5.0', releaseUrl: 'https://r' }),
  )
  const status = await checkForUpdate({
    cachePath,
    currentVersion: '0.4.1',
    now: old + 10 * 24 * 60 * 60 * 1000,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })

  expect(status.offline).toBe(true)
  expect(status.source).toBe('cache')
  expect(status.updateAvailable).toBe(true)
})

test('an offline run with no cache reports no update', async () => {
  const status = await checkForUpdate({
    cachePath: tmpCachePath(),
    currentVersion: '0.4.1',
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })

  expect(status.offline).toBe(true)
  expect(status.latestVersion).toBe(null)
  expect(status.updateAvailable).toBe(false)
})

test('formatUpdateNotice renders only when an update is available', () => {
  expect(
    formatUpdateNotice({
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      updateAvailable: true,
      releaseUrl: 'https://example/r',
      checkedAt: 0,
      source: 'network',
      offline: false,
    }),
  ).toContain('0.4.1 -> 0.5.0')

  expect(
    formatUpdateNotice({
      currentVersion: '0.4.1',
      latestVersion: '0.4.1',
      updateAvailable: false,
      releaseUrl: null,
      checkedAt: 0,
      source: 'cache',
      offline: false,
    }),
  ).toBe(null)
})
