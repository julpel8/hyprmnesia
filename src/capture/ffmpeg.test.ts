// Tests for the ffmpeg capture module:
//   - ffmpegSearchPaths (pure path-resolution priority)
//   - needsImageTranscode (pure)
//   - transcodeImage (ffmpeg shellout integration)
//
// transcodeImage spawns ffmpeg via getFfmpegPath() — required on the system
// PATH (or bundled in dist/native). The integration tests skip when no ffmpeg
// is locatable so this file stays green on bare CI runners.

import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { hasValidWebpRiffSize, isWebp } from '../util/webp'
import {
  encodePcm16WebmOpus,
  ffmpegSearchPaths,
  getFfmpegPath,
  needsImageTranscode,
  transcodeImage,
} from './ffmpeg'

// ---- ffmpegSearchPaths: pure path-resolution priority --------------------

test('ffmpeg search prefers packaged native binary before the system path', () => {
  const root = join('tmp', 'hyprmnesia')
  const nativePath = join(root, 'native', 'ffmpeg')
  const paths = ffmpegSearchPaths({
    env: {},
    execPath: join(root, 'hpm'),
    cwd: root,
  })

  expect(paths).toContain(nativePath)
  expect(paths.indexOf(nativePath)).toBeLessThan(paths.indexOf('/usr/bin/ffmpeg'))
})

test('ffmpeg search falls back to the system ffmpeg on Linux', () => {
  const root = join('tmp', 'hyprmnesia')
  const paths = ffmpegSearchPaths({
    env: {},
    execPath: join(root, 'hpm'),
    cwd: root,
  })

  expect(paths).toContain('/usr/bin/ffmpeg')
})

// ---- needsImageTranscode: pure unit tests --------------------------------

test('needsImageTranscode: png at native resolution is a pass-through', () => {
  expect(needsImageTranscode({ format: 'png', quality: 100, maxWidth: 0 })).toBe(false)
})

test('needsImageTranscode: any jpg output requires transcoding', () => {
  expect(needsImageTranscode({ format: 'jpg', quality: 80, maxWidth: 0 })).toBe(true)
})

test('needsImageTranscode: webp output requires transcoding', () => {
  expect(needsImageTranscode({ format: 'webp', quality: 80, maxWidth: 0 })).toBe(true)
})

test('needsImageTranscode: maxWidth > 0 forces transcoding even for png', () => {
  expect(needsImageTranscode({ format: 'png', quality: 100, maxWidth: 1280 })).toBe(true)
})

test('needsImageTranscode: maxWidth of 0 disables clamping', () => {
  expect(needsImageTranscode({ format: 'png', quality: 100, maxWidth: 0 })).toBe(false)
})

// ---- transcodeImage: spawn ffmpeg ----------------------------------------

// Locate ffmpeg up front. If we can't, skip the integration suite entirely so
// the file still passes on machines without ffmpeg installed.
let ffmpegAvailable = false
try {
  getFfmpegPath()
  ffmpegAvailable = true
} catch {
  ffmpegAvailable = false
}

// Generate a known fixture once: a 200x100 solid-color PNG. We pipe lavfi's
// `color` source into pngenc rather than checking a binary blob into the repo.
async function synthPng(
  width: number,
  height: number,
  color = 'red',
  format: 'png' | 'mjpeg' = 'png',
): Promise<Buffer> {
  const proc = Bun.spawn(
    [
      getFfmpegPath(),
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${width}x${height}`,
      '-frames:v',
      '1',
      '-f',
      format === 'png' ? 'image2pipe' : 'mjpeg',
      '-c:v',
      format === 'png' ? 'png' : 'mjpeg',
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer())
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`lavfi fixture (${color} ${width}x${height} ${format}) failed: ${stderr}`)
  }
  return out
}

// Probe an encoded image with ffprobe-via-ffmpeg: ffmpeg's -loglevel info on
// stderr is more universal than depending on ffprobe being available.
async function probeDimensions(image: Buffer): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    [getFfmpegPath(), '-hide_banner', '-loglevel', 'info', '-i', 'pipe:0', '-f', 'null', '-'],
    { stdin: image, stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const match = stderr.match(/(\d+)x(\d+)[,\s]/)
  if (!match) throw new Error(`could not parse dimensions from ffmpeg stderr:\n${stderr}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

async function ffmpegHasEncoder(name: string): Promise<boolean> {
  const proc = Bun.spawn([getFfmpegPath(), '-hide_banner', '-encoders'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text.includes(name)
}

function pngMagic(buf: Buffer): boolean {
  // 89 50 4E 47 0D 0A 1A 0A
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
}

function jpegMagic(buf: Buffer): boolean {
  // FFD8 ... FFD9
  return (
    buf.length >= 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  )
}

function webmMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
}

describe.if(ffmpegAvailable)('transcodeImage (with ffmpeg)', () => {
  let pngWide: Buffer
  let pngNarrow: Buffer
  let jpegSrc: Buffer

  beforeAll(async () => {
    pngWide = await synthPng(200, 100, 'red', 'png')
    pngNarrow = await synthPng(80, 40, 'green', 'png')
    jpegSrc = await synthPng(200, 100, 'blue', 'mjpeg')
  })

  test('png → png pass-through emits a valid PNG', async () => {
    const out = await transcodeImage(pngWide, { format: 'png', quality: 100, maxWidth: 0 })
    expect(pngMagic(out)).toBe(true)
    const dim = await probeDimensions(out)
    expect(dim).toEqual({ width: 200, height: 100 })
  })

  test('png → jpg conversion produces a JPEG with the same dimensions', async () => {
    const out = await transcodeImage(pngWide, { format: 'jpg', quality: 80, maxWidth: 0 })
    expect(jpegMagic(out)).toBe(true)
    const dim = await probeDimensions(out)
    expect(dim).toEqual({ width: 200, height: 100 })
  })

  test('jpg → jpg with quality change is still a JPEG', async () => {
    const highQ = await transcodeImage(jpegSrc, { format: 'jpg', quality: 95, maxWidth: 0 })
    const lowQ = await transcodeImage(jpegSrc, { format: 'jpg', quality: 20, maxWidth: 0 })
    expect(jpegMagic(highQ)).toBe(true)
    expect(jpegMagic(lowQ)).toBe(true)
    // Heuristic: lower quality => smaller byte size on a flat input.
    expect(lowQ.length).toBeLessThanOrEqual(highQ.length)
  })

  test('png to lossy webp conversion produces a WebP image', async () => {
    if (!(await ffmpegHasEncoder('libwebp'))) return
    const out = await transcodeImage(pngWide, { format: 'webp', quality: 75, maxWidth: 0 })
    expect(isWebp(out)).toBe(true)
    expect(hasValidWebpRiffSize(out)).toBe(true)
    const dim = await probeDimensions(out)
    expect(dim).toEqual({ width: 200, height: 100 })
  })

  test('maxWidth clamps wider input proportionally', async () => {
    const out = await transcodeImage(pngWide, { format: 'png', quality: 100, maxWidth: 100 })
    expect(pngMagic(out)).toBe(true)
    const dim = await probeDimensions(out)
    expect(dim.width).toBe(100)
    // Aspect-ratio preserved (200x100 -> 100x50). The scale filter uses -2 so
    // height is even; 50 is exact here.
    expect(dim.height).toBe(50)
  })

  test('maxWidth does not upscale narrower input', async () => {
    // Source is 80px; maxWidth=200 means "min(200, iw)" => 80.
    const out = await transcodeImage(pngNarrow, { format: 'png', quality: 100, maxWidth: 200 })
    const dim = await probeDimensions(out)
    expect(dim.width).toBe(80)
    expect(dim.height).toBe(40)
  })

  test('invalid input bytes → returns the original buffer (documented fallback)', async () => {
    const garbage = Buffer.from('not a real image, ffmpeg should refuse to decode this')
    const out = await transcodeImage(garbage, { format: 'jpg', quality: 80, maxWidth: 0 })
    // ffmpeg exits non-zero on bad input; transcodeImage returns the original.
    expect(out).toBe(garbage)
  })

  test('empty input → returns the original (zero-length) buffer', async () => {
    const empty = Buffer.alloc(0)
    const out = await transcodeImage(empty, { format: 'jpg', quality: 80, maxWidth: 0 })
    expect(out).toBe(empty)
  })

  test('encodePcm16WebmOpus writes a compact WebM/Opus blob', async () => {
    if (!(await ffmpegHasEncoder('libopus'))) return
    const pcm = Buffer.alloc(16_000)
    const out = await encodePcm16WebmOpus(pcm, 16_000, { bitrateKbps: 24 })
    expect(webmMagic(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(pcm.length)
  })
})
