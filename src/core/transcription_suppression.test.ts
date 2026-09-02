import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearReplayTranscriptionSuppression,
  isReplayTranscriptionSuppressed,
  setReplayTranscriptionSuppression,
} from './transcription_suppression'

const dirs: string[] = []
const T = Date.UTC(2026, 0, 1, 12, 0, 0)

function tempMarker(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-suppress-'))
  dirs.push(dir)
  return join(dir, 'marker.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('replay transcription suppression is active until its marker expires', () => {
  const file = tempMarker()

  expect(isReplayTranscriptionSuppressed({ file, now: T })).toBe(false)
  const until = setReplayTranscriptionSuppression({ file, now: T, ttlMs: 1_000, owner: 'replay-1' })

  expect(until).toBe(T + 1_000)
  expect(isReplayTranscriptionSuppressed({ file, now: T + 999 })).toBe(true)
  expect(isReplayTranscriptionSuppressed({ file, now: T + 1_000 })).toBe(false)
  expect(isReplayTranscriptionSuppressed({ file, now: T + 1_250 })).toBe(false)
  expect(existsSync(file)).toBe(false)
})

test('clearReplayTranscriptionSuppression respects marker ownership', () => {
  const file = tempMarker()
  setReplayTranscriptionSuppression({ file, now: T, ttlMs: 1_000, owner: 'replay-1' })

  expect(clearReplayTranscriptionSuppression({ file, owner: 'other' })).toBe(false)
  expect(isReplayTranscriptionSuppressed({ file, now: T + 1 })).toBe(true)

  expect(clearReplayTranscriptionSuppression({ file, owner: 'replay-1' })).toBe(true)
  expect(isReplayTranscriptionSuppressed({ file, now: T + 2 })).toBe(false)
})
