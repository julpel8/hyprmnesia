import { expect, test } from 'bun:test'
import { tesseractSearchPaths } from './tesseract'

test('tesseract search uses explicit binary paths as-is', () => {
  expect(
    tesseractSearchPaths({
      binary: '/custom/bin/tesseract',
      env: {},
    }),
  ).toEqual(['/custom/bin/tesseract'])
})

test('tesseract search checks system paths when PATH is sparse', () => {
  const paths = tesseractSearchPaths({ env: { PATH: '/custom/bin' } })
  expect(paths).toContain('/custom/bin/tesseract')
  expect(paths).toContain('/usr/bin/tesseract')
})

test('tesseract search accepts env override names', () => {
  const paths = tesseractSearchPaths({
    env: { HPM_TESSERACT: 'custom-tesseract', PATH: '/usr/local/bin' },
  })
  expect(paths).toContain('/usr/local/bin/custom-tesseract')
})
