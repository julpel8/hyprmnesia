import { expect, test } from 'bun:test'
import { sliceRange } from './range'

test('returns null when there is no Range header', () => {
  expect(sliceRange(1000, null)).toBeNull()
  expect(sliceRange(1000, undefined)).toBeNull()
  expect(sliceRange(1000, '')).toBeNull()
})

test('parses a closed range', () => {
  expect(sliceRange(1000, 'bytes=100-199')).toEqual({ start: 100, end: 199 })
})

test('open-ended range runs to the last byte', () => {
  expect(sliceRange(1000, 'bytes=500-')).toEqual({ start: 500, end: 999 })
})

test('the common bytes=0- request covers the whole resource', () => {
  expect(sliceRange(1000, 'bytes=0-')).toEqual({ start: 0, end: 999 })
})

test('suffix range returns the final N bytes', () => {
  expect(sliceRange(1000, 'bytes=-200')).toEqual({ start: 800, end: 999 })
  expect(sliceRange(100, 'bytes=-500')).toEqual({ start: 0, end: 99 }) // clamps to size
})

test('clamps an end past the resource size', () => {
  expect(sliceRange(1000, 'bytes=900-5000')).toEqual({ start: 900, end: 999 })
})

test('returns null for unsatisfiable or malformed ranges', () => {
  expect(sliceRange(1000, 'bytes=1000-1100')).toBeNull() // start past end
  expect(sliceRange(1000, 'bytes=300-200')).toBeNull() // start > end
  expect(sliceRange(0, 'bytes=0-10')).toBeNull() // empty resource
  expect(sliceRange(1000, 'items=0-10')).toBeNull() // wrong unit
  expect(sliceRange(1000, 'bytes=abc-def')).toBeNull()
  expect(sliceRange(1000, 'bytes=-')).toBeNull()
})
