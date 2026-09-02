import { expect, test } from 'bun:test'
import type { ReplayChunk, ReplayManifest } from '../../replay/store'
import { handleReadRequest, withBlobUrls } from './read'

function replayChunk(overrides: Partial<ReplayChunk> = {}): ReplayChunk {
  return {
    id: 'screen/1',
    kind: 'screenshot',
    source: 'screen',
    at: 0,
    local_at: '',
    utc_at: '',
    start_at: 0,
    local_start_at: '',
    utc_start_at: '',
    end_at: null,
    local_end_at: null,
    utc_end_at: null,
    offset_start_ms: 0,
    offset_end_ms: null,
    blob_start_offset_ms: 0,
    duration_ms: null,
    bytes: 10,
    has_blob: true,
    mime_type: 'image/webp',
    text: '',
    window: { app: null, title: null, url: null, pid: null },
    ...overrides,
  }
}

test('blob urls stay same-origin, are id-encoded, and never leak the token', () => {
  const manifest: ReplayManifest = {
    from: 0,
    to: 1,
    duration_ms: 1,
    timezone: 'UTC',
    local_from: '',
    utc_from: '',
    local_to: '',
    utc_to: '',
    screenshots: [replayChunk({ id: 'screen/1' })],
    audio: {
      mic: [replayChunk({ id: 'mic 1', kind: 'audio_mic', source: 'mic' })],
      system: [replayChunk({ id: 'sys', kind: 'audio_system', source: 'system', has_blob: false })],
    },
    segments: [],
  }

  const withUrls = withBlobUrls(manifest)

  expect(withUrls.screenshots[0]?.blob_url).toBe('/media/screen%2F1')
  expect(withUrls.audio.mic[0]?.blob_url).toBe('/media/mic%201')
  expect(withUrls.audio.system[0]?.blob_url).toBeNull()
  expect(JSON.stringify(withUrls)).not.toContain('token=')
})

test('/api/hosts lists the machines replay can play back', async () => {
  const res = handleReadRequest(new Request('http://x/api/hosts'), new URL('http://x/api/hosts'), {
    blobs: { current: new Map() },
    headers: () => ({}),
  })
  expect(res).toBeDefined()
  const hosts = (await (res as Response).json()) as { host_id: string; is_local: boolean }[]
  expect(Array.isArray(hosts)).toBe(true)
  for (const host of hosts) {
    expect(typeof host.host_id).toBe('string')
    expect(typeof host.is_local).toBe('boolean')
  }
  // At most one machine can be the one we are running on.
  expect(hosts.filter((host) => host.is_local).length).toBeLessThanOrEqual(1)
})
