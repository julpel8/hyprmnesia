import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigForEditing } from '../config'
import { audioCaptureState, isAudioSource, setAudioCapture } from './capture_toggle'

const dirs: string[] = []

function tmpConfig(contents = '{}'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-toggle-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, contents)
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('both audio sources are on by default', () => {
  expect(audioCaptureState(tmpConfig())).toEqual({ mic: true, system: true })
})

test('setting a source off persists it without touching the other one', () => {
  const path = tmpConfig()
  expect(setAudioCapture('mic', false, path)).toEqual({ mic: false, system: true })
  expect(audioCaptureState(path)).toEqual({ mic: false, system: true })
  expect(loadConfigForEditing(path).capture.audio.mic.enabled).toBe(false)
})

test('an undefined value flips the persisted flag', () => {
  const path = tmpConfig()
  expect(setAudioCapture('system', undefined, path)).toEqual({ mic: true, system: false })
  expect(setAudioCapture('system', undefined, path)).toEqual({ mic: true, system: true })
})

test('isAudioSource rejects the screen source', () => {
  expect(isAudioSource('mic')).toBe(true)
  expect(isAudioSource('system')).toBe(true)
  expect(isAudioSource('screen')).toBe(false)
})
