import { expect, test } from 'bun:test'
import { pad, shortDuration } from './format'

test('pad: zero-pads to width (default 2)', () => {
  expect(pad(0)).toBe('00')
  expect(pad(7)).toBe('07')
  expect(pad(12)).toBe('12')
  expect(pad(5, 3)).toBe('005')
  expect(pad(123, 2)).toBe('123')
})

test('shortDuration: minutes only below an hour', () => {
  expect(shortDuration(0)).toBe('0m')
  expect(shortDuration(5 * 60_000)).toBe('5m')
  expect(shortDuration(59 * 60_000)).toBe('59m')
})

test('shortDuration: hours and zero-padded minutes at/above an hour', () => {
  expect(shortDuration(60 * 60_000)).toBe('1h00')
  expect(shortDuration(83 * 60_000)).toBe('1h23')
  expect(shortDuration(125 * 60_000)).toBe('2h05')
})
