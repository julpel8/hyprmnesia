import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '../config'
import { defaultDbPath, expandHome } from '../util/paths'

// One machine's slice of the shared tree. `dir` is what blob paths are resolved
// against; `dbPath` is the index to read.
export interface HostSource {
  hostId: string
  dir: string
  dbPath: string
  // The machine we are running on. Its index is read live rather than from the
  // snapshot, which is up to snapshot_interval_minutes behind.
  isLocal: boolean
}

export interface HostDiscoveryOptions {
  root: string
  localHostId: string
  // Overridable so tests and `--db` can point at another live index.
  localDbPath?: string
}

// Lists the machines present in the shared tree. A directory without an
// index.db is skipped: Syncthing may still be copying it over, and blobs
// without an index are unreadable anyway.
export function discoverHosts(opts: HostDiscoveryOptions): HostSource[] {
  const root = expandHome(opts.root)
  const localDbPath = opts.localDbPath ?? defaultDbPath()
  const hosts: HostSource[] = []

  if (existsSync(localDbPath)) {
    hosts.push({
      hostId: opts.localHostId,
      dir: join(root, opts.localHostId),
      dbPath: localDbPath,
      isLocal: true,
    })
  }

  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    // No shared tree yet: the local index alone is a valid answer.
    return hosts
  }

  for (const hostId of entries) {
    if (hostId === opts.localHostId) continue
    const dir = join(root, hostId)
    const dbPath = join(dir, 'index.db')
    if (!existsSync(dbPath)) continue
    hosts.push({ hostId, dir, dbPath, isLocal: false })
  }

  return hosts
}

// How long a discovery result is reused. Scanning the shared tree and reading
// the config on every read-store call would be wasteful; a few seconds is short enough
// that a machine appearing in the folder shows up almost at once.
const HOST_CACHE_TTL_MS = 5_000
let cache: { key: string; at: number; hosts: HostSource[] } | undefined

// Host list for this machine's configuration. `localDbPath` overrides the live
// index, for tests and for `--db`.
export function hostSources(localDbPath?: string): HostSource[] {
  const dbPath = localDbPath ?? defaultDbPath()
  // Pointing at a database explicitly (`--db`, tests) means that database and
  // nothing else. Only the machine's own index is read together with the other
  // machines of the shared tree.
  if (localDbPath && localDbPath !== defaultDbPath()) {
    return [{ hostId: '', dir: dirname(dbPath), dbPath, isLocal: true }]
  }
  let cfg: ReturnType<typeof loadConfig>
  try {
    cfg = loadConfig()
  } catch {
    // A missing or rejected config must not take reading down with it: fall
    // back to the local index alone, with its blobs sitting next to it. The
    // daemon reports the config problem loudly enough on its own.
    return [{ hostId: '', dir: dirname(dbPath), dbPath, isLocal: true }]
  }
  return discoverHosts({
    root: cfg.storage.path,
    localHostId: cfg.storage.host_id,
    localDbPath: dbPath,
  })
}

export function cachedHostSources(localDbPath?: string): HostSource[] {
  const key = localDbPath ?? ''
  const now = Date.now()
  if (cache && cache.key === key && now - cache.at < HOST_CACHE_TTL_MS) return cache.hosts
  const hosts = hostSources(localDbPath)
  cache = { key, at: now, hosts }
  return hosts
}
