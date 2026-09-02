import { expect, test } from 'bun:test'
import { hasValidWebpRiffSize, isWebp, repairWebpRiffSize } from './webp'

test('repairWebpRiffSize patches ffmpeg pipe WebP files with a zero RIFF size', () => {
  const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 \x04\0\0\0data', 'binary')

  expect(isWebp(webp)).toBe(true)
  expect(hasValidWebpRiffSize(webp)).toBe(false)

  const repaired = repairWebpRiffSize(webp)

  expect(repaired).not.toBe(webp)
  expect(hasValidWebpRiffSize(repaired)).toBe(true)
  expect(repaired.readUInt32LE(4)).toBe(repaired.length - 8)
  expect(repaired.subarray(8)).toEqual(webp.subarray(8))
})

test('repairWebpRiffSize leaves non-WebP buffers untouched', () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\n', 'binary')

  expect(repairWebpRiffSize(png)).toBe(png)
  expect(isWebp(png)).toBe(false)
})
