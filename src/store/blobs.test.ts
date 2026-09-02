import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { makeBlobStore } from './blobs'

const dirs: string[] = []

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-blobs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('path() partitions by UTC date at a timezone frontier', () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.parse('2024-12-31T23:30:00-01:00') // 2025-01-01T00:30:00Z

  expect(store.path('screenshot', 'frontier', 'png', at)).toEqual({
    abs: join(root, 'data', 'screenshot', '2025', '01', '01', 'frontier.png'),
    rel: join('data', 'screenshot', '2025', '01', '01', 'frontier.png'),
  })
})

test('path() zero-pads month and day without creating directories', () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 2, 4, 12)
  const path = store.path('audio_mic', 'chunk-1', 'wav', at)

  expect(path.abs).toBe(join(root, 'data', 'audio_mic', '2025', '03', '04', 'chunk-1.wav'))
  expect(path.rel).toBe(join('data', 'audio_mic', '2025', '03', '04', 'chunk-1.wav'))
  expect(isAbsolute(path.abs)).toBe(true)
  expect(isAbsolute(path.rel)).toBe(false)
  expect(existsSync(join(root, 'data', 'audio_mic'))).toBe(false)
})

test('write() writes the bytes verbatim', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 6, 9)
  const data = Buffer.from('hello plaintext')
  const expected = join(root, 'data', 'screenshot', '2025', '07', '09', 'img-1.jpg')

  const written = await store.write('screenshot', 'img-1', 'jpg', data, at)
  const onDisk = readFileSync(written.abs)

  expect(written.abs).toBe(expected)
  expect(isAbsolute(written.abs)).toBe(true)
  expect(onDisk.equals(data)).toBe(true)
})

test('write() can reuse an existing partition directory', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 0, 2)

  const first = await store.write('audio_system', 'a', 'wav', Buffer.from('first'), at)
  const second = await store.write('audio_system', 'b', 'wav', Buffer.from('second'), at)

  expect(readFileSync(first.abs).toString('utf8')).toBe('first')
  expect(readFileSync(second.abs).toString('utf8')).toBe('second')
  expect(second.abs).toBe(join(root, 'data', 'audio_system', '2025', '01', '02', 'b.wav'))
})

test('path() matches write() layout for the same inputs', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 10, 11)
  const expected = store.path('screenshot', 'same-layout', 'png', at)

  const written = await store.write('screenshot', 'same-layout', 'png', Buffer.from('x'), at)

  expect(written).toEqual(expected)
})

test('write() propagates mkdir errors other than EEXIST', async () => {
  const root = freshRoot()
  const blocker = join(root, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const store = makeBlobStore(blocker)

  await expect(store.write('screenshot', 'blocked', 'png', Buffer.from('x'))).rejects.toThrow()
})
