import { expect, test } from 'bun:test'
import { domainFromUrl, parseProjectContext } from './project'

test('domainFromUrl keeps http(s) hosts and strips www', () => {
  expect(domainFromUrl('https://www.github.com/foo/bar')).toBe('github.com')
  expect(domainFromUrl('http://docs.rs/serde')).toBe('docs.rs')
  expect(domainFromUrl('https://GitHub.com')).toBe('github.com')
})

test('domainFromUrl rejects non-http schemes and garbage', () => {
  expect(domainFromUrl('ftp://example.com')).toBeNull()
  expect(domainFromUrl('file:///etc/passwd')).toBeNull()
  expect(domainFromUrl('not a url')).toBeNull()
  expect(domainFromUrl(null)).toBeNull()
  expect(domainFromUrl('')).toBeNull()
})

test('VS Code-family titles yield the workspace folder as repo', () => {
  expect(parseProjectContext('db.ts - hyprmnesia - Visual Studio Code')).toEqual({
    repo: 'hyprmnesia',
    branch: null,
    ssh_host: null,
    source: 'window_title',
  })
  expect(parseProjectContext('main.rs — asr — Cursor')).toEqual({
    repo: 'asr',
    branch: null,
    ssh_host: null,
    source: 'window_title',
  })
})

test('editor folder segment with [branch] captures the branch', () => {
  expect(parseProjectContext('cli.ts - hyprmnesia [feat/sync] - Code')).toEqual({
    repo: 'hyprmnesia',
    branch: 'feat/sync',
    ssh_host: null,
    source: 'window_title',
  })
})

test('ssh window titles yield the host', () => {
  expect(parseProjectContext('julien@build-server: ~/hyprmnesia')).toEqual({
    repo: null,
    branch: null,
    ssh_host: 'build-server',
    source: 'window_title',
  })
  expect(parseProjectContext('ssh root@100.64.0.7')).toEqual({
    repo: null,
    branch: null,
    ssh_host: '100.64.0.7',
    source: 'window_title',
  })
})

test('plain titles never produce a false project', () => {
  expect(parseProjectContext('Inbox - me@example.com - Gmail')).toBeNull() // not an editor product
  expect(parseProjectContext('How to - cook - rice')).toBeNull()
  expect(parseProjectContext('Terminal')).toBeNull()
  expect(parseProjectContext(null)).toBeNull()
  expect(parseProjectContext('')).toBeNull()
})

test('an email address alone does not count as an ssh host', () => {
  // The mail case has no ":"/path structure after the host; the regex still
  // requires a host-ish token, so guard the common inbox title shape.
  expect(parseProjectContext('me@example.com - Inbox')).toBeNull()
})
