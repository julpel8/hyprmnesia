import { expect, test } from 'bun:test'
import type { WindowContext } from '../core/events'
import { windowChanged } from './window_context'

function win(overrides: Partial<WindowContext> = {}): WindowContext {
  return {
    app: 'Chrome',
    title: 'Dashboard',
    url: 'https://example.test',
    pid: 100,
    ...overrides,
  }
}

test('windowChanged: both undefined means no change', () => {
  expect(windowChanged(undefined, undefined)).toBe(false)
})

test('windowChanged: focus appearing or disappearing is a change', () => {
  expect(windowChanged(undefined, win())).toBe(true)
  expect(windowChanged(win(), undefined)).toBe(true)
})

test('windowChanged: same app/title/url means no change', () => {
  expect(windowChanged(win({ pid: 100 }), win({ pid: 100 }))).toBe(false)
})

test('windowChanged: app, title, and url are part of equality', () => {
  expect(windowChanged(win(), win({ app: 'Code' }))).toBe(true)
  expect(windowChanged(win(), win({ title: 'Pull Request' }))).toBe(true)
  expect(windowChanged(win(), win({ url: 'https://example.test/other' }))).toBe(true)
})

test('windowChanged: pid changes are intentionally ignored', () => {
  expect(windowChanged(win({ pid: 100 }), win({ pid: 200 }))).toBe(false)
})

test('windowChanged: missing url and empty url are distinct states', () => {
  expect(windowChanged(win({ url: undefined }), win({ url: '' }))).toBe(true)
})
