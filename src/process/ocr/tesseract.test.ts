import { expect, test } from 'bun:test'
import { tesseractSearchPaths } from './tesseract'

test('tesseract search uses explicit binary paths as-is', () => {
  expect(
    tesseractSearchPaths({
      binary: '/custom/bin/tesseract',
      env: {},
      platform: 'darwin',
    }),
  ).toEqual(['/custom/bin/tesseract'])
})

test('tesseract search checks Homebrew paths on macOS when PATH is sparse', () => {
  const paths = tesseractSearchPaths({ env: { PATH: '/usr/bin' }, platform: 'darwin' })
  expect(paths).toContain('/opt/homebrew/bin/tesseract')
  expect(paths).toContain('/usr/local/bin/tesseract')
})

test('tesseract search checks system paths on Linux when PATH is sparse', () => {
  const paths = tesseractSearchPaths({ env: { PATH: '/custom/bin' }, platform: 'linux' })
  expect(paths).toContain('/custom/bin/tesseract')
  expect(paths).toContain('/usr/bin/tesseract')
})

test('tesseract search accepts env override names', () => {
  const paths = tesseractSearchPaths({
    env: { HPM_TESSERACT: 'custom-tesseract', PATH: '/usr/local/bin' },
    platform: 'linux',
  })
  expect(paths).toContain('/usr/local/bin/custom-tesseract')
})
