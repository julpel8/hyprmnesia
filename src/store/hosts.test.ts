import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverHosts, hostSources } from './hosts'

const dirs: string[] = []

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-hosts-'))
  dirs.push(dir)
  return dir
}

function makeHost(root: string, hostId: string, withDb = true): void {
  const dir = join(root, hostId)
  mkdirSync(dir, { recursive: true })
  if (withDb) writeFileSync(join(dir, 'index.db'), '')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the local machine comes first and reads its live index, not its snapshot', () => {
  const root = freshRoot()
  makeHost(root, 'rpi5')
  makeHost(root, 'dell')
  const live = join(freshRoot(), 'live.db')
  writeFileSync(live, '')

  const hosts = discoverHosts({ root, localHostId: 'rpi5', localDbPath: live })

  expect(hosts.map((h) => h.hostId)).toEqual(['rpi5', 'dell'])
  expect(hosts[0]!.dbPath).toBe(live)
  expect(hosts[0]!.dir).toBe(join(root, 'rpi5'))
  expect(hosts[0]!.isLocal).toBe(true)
  expect(hosts[1]!.dbPath).toBe(join(root, 'dell', 'index.db'))
  expect(hosts[1]!.isLocal).toBe(false)
})

test('a directory without an index.db is skipped', () => {
  const root = freshRoot()
  makeHost(root, 'dell', false)
  const live = join(freshRoot(), 'live.db')
  writeFileSync(live, '')

  expect(
    discoverHosts({ root, localHostId: 'rpi5', localDbPath: live }).map((h) => h.hostId),
  ).toEqual(['rpi5'])
})

test('dot-directories are ignored', () => {
  const root = freshRoot()
  makeHost(root, '.stversions')
  const live = join(freshRoot(), 'live.db')
  writeFileSync(live, '')

  expect(
    discoverHosts({ root, localHostId: 'rpi5', localDbPath: live }).map((h) => h.hostId),
  ).toEqual(['rpi5'])
})

test('a missing shared tree still yields the local machine', () => {
  const live = join(freshRoot(), 'live.db')
  writeFileSync(live, '')

  const hosts = discoverHosts({
    root: '/nonexistent/hyprmnesia-sync',
    localHostId: 'rpi5',
    localDbPath: live,
  })
  expect(hosts).toHaveLength(1)
  expect(hosts[0]!.isLocal).toBe(true)
})

test('a missing local index leaves only the other machines', () => {
  const root = freshRoot()
  makeHost(root, 'dell')

  const hosts = discoverHosts({
    root,
    localHostId: 'rpi5',
    localDbPath: join(root, 'nope', 'index.db'),
  })
  expect(hosts.map((h) => h.hostId)).toEqual(['dell'])
})

test('an explicit db path is read alone, without the shared tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-hosts-'))
  const dbPath = join(dir, 'other.db')
  writeFileSync(dbPath, '')
  const sources = hostSources(dbPath)
  expect(sources).toHaveLength(1)
  expect(sources[0]?.dbPath).toBe(dbPath)
  expect(sources[0]?.dir).toBe(dir)
  rmSync(dir, { recursive: true, force: true })
})
