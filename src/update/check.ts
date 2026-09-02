// Update detection via the GitHub Releases API. This is notification-only: it
// never downloads or installs anything. The automatic notice on `hpm start`
// reads from a daily cache and respects opt-out (config + env), while
// `hpm update` always forces a fresh, opt-out-bypassing check.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { updateCheckPath } from '../util/paths'
import { VERSION } from '../version'

const REPO = 'hyprmnesia/hyprmnesia'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

// Hit GitHub at most once per day for the automatic notice. `hpm update` passes
// `force` to bypass this.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Keep `hpm start` snappy: the check piggybacks on an already-detached daemon,
// so a slow or offline network must not stall the prompt for long.
const DEFAULT_TIMEOUT_MS = 1500

interface UpdateCache {
  checkedAt: number
  latestVersion: string | null
  releaseUrl: string | null
  // ETag from the previous response, sent as If-None-Match so unchanged
  // releases come back as a cheap 304.
  etag?: string
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  checkedAt: number
  source: 'network' | 'not-modified' | 'cache'
  // True when the network could not be reached and the result is a (possibly
  // empty) cache fallback rather than a live answer.
  offline: boolean
}

// Minimal structural shape of the parts of `fetch`'s Response we use. Lets tests
// inject a fake without pulling in the full DOM `fetch` type.
interface FetchLikeResponse {
  status: number
  ok: boolean
  json(): Promise<unknown>
  headers: { get(name: string): string | null }
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchLikeResponse>

export interface CheckOptions {
  // Bypass the daily cache TTL and the env/config opt-out. Used by `hpm update`.
  force?: boolean
  cachePath?: string
  timeoutMs?: number
  now?: number
  fetchImpl?: FetchLike
  currentVersion?: string
}

/**
 * Returns true when the automatic update check should be skipped because the
 * environment opted out (`HPM_NO_UPDATE_CHECK`) or we are running under CI.
 * Explicit `hpm update` ignores this.
 */
export function envOptOut(): boolean {
  return isTruthyEnv(process.env.HPM_NO_UPDATE_CHECK) || isTruthyEnv(process.env.CI)
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false'
}

/**
 * Parses a `MAJOR.MINOR.PATCH[-prerelease][+build]` core version. Returns null
 * when the string is not semver-shaped.
 */
function parseSemver(raw: string): { parts: number[]; prerelease: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null }
}

/**
 * Compares two semver strings, returning -1, 0, or 1. A release without a
 * prerelease tag outranks the same core version with one (1.0.0 > 1.0.0-rc.1).
 * Unparseable inputs compare equal so a malformed tag never claims an update.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (pa.prerelease === pb.prerelease) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  if (pa.prerelease < pb.prerelease) return -1
  return pa.prerelease > pb.prerelease ? 1 : 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0
}

/** Strips a leading `v`/`V` from a release tag, e.g. `v0.5.0` -> `0.5.0`. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

function readCache(path: string): UpdateCache | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCache>
    if (typeof parsed.checkedAt !== 'number') return undefined
    return {
      checkedAt: parsed.checkedAt,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
      releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : null,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
    }
  } catch {
    return undefined
  }
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(cache)}\n`)
  } catch {
    // A non-writable cache only costs us an extra network call next time.
  }
}

function isCacheFresh(cache: UpdateCache, now: number, ttl: number): boolean {
  return now >= cache.checkedAt && now - cache.checkedAt < ttl
}

function statusFrom(
  cache: UpdateCache,
  currentVersion: string,
  source: UpdateStatus['source'],
  offline: boolean,
): UpdateStatus {
  const latestVersion = cache.latestVersion
  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion ? isNewerVersion(latestVersion, currentVersion) : false,
    releaseUrl: cache.releaseUrl,
    checkedAt: cache.checkedAt,
    source,
    offline,
  }
}

function offlineStatus(cache: UpdateCache | undefined, currentVersion: string): UpdateStatus {
  if (cache) return statusFrom(cache, currentVersion, 'cache', true)
  return {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    checkedAt: 0,
    source: 'cache',
    offline: true,
  }
}

/**
 * Resolves the latest release, preferring a fresh cache and falling back to it
 * when the network is unreachable. Never throws: callers treat any failure as
 * "no update info available".
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateStatus> {
  const now = opts.now ?? Date.now()
  const cachePath = opts.cachePath ?? updateCheckPath()
  const currentVersion = opts.currentVersion ?? VERSION
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const cache = readCache(cachePath)

  if (!opts.force && cache && isCacheFresh(cache, now, CACHE_TTL_MS)) {
    return statusFrom(cache, currentVersion, 'cache', false)
  }

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `hyprmnesia-cli/${currentVersion}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (cache?.etag) headers['If-None-Match'] = cache.etag

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let res: FetchLikeResponse
    try {
      res = await fetchImpl(LATEST_RELEASE_API, { headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 304 && cache) {
      const refreshed: UpdateCache = { ...cache, checkedAt: now }
      writeCache(cachePath, refreshed)
      return statusFrom(refreshed, currentVersion, 'not-modified', false)
    }

    if (!res.ok) {
      // Rate limits and 5xx are transient; reuse the cache like an offline run.
      return offlineStatus(cache, currentVersion)
    }

    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    const fresh: UpdateCache = {
      checkedAt: now,
      latestVersion: typeof body.tag_name === 'string' ? normalizeTag(body.tag_name) : null,
      releaseUrl: typeof body.html_url === 'string' ? body.html_url : RELEASES_URL,
      etag: res.headers.get('etag') ?? undefined,
    }
    writeCache(cachePath, fresh)
    return statusFrom(fresh, currentVersion, 'network', false)
  } catch {
    return offlineStatus(cache, currentVersion)
  }
}

/**
 * Builds the multi-line notice shown on `hpm start`, or null when no newer
 * release is available.
 */
export function formatUpdateNotice(status: UpdateStatus): string | null {
  if (!status.updateAvailable || !status.latestVersion) return null
  const url = status.releaseUrl ?? RELEASES_URL
  return `A new Hyprmnesia release is available: ${status.currentVersion} -> ${status.latestVersion}\n  ${url}`
}
