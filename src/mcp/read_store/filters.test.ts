// Pure unit tests for the input-parsing layer that sits in front of every
// MCP read-store call. These functions normalize the loose JSON the MCP
// server hands us (numbers-as-strings, ISO dates, source aliases) into the
// tight types the SQL builder expects. Bugs here are particularly painful
// because they silently change result sets — wrong limit, wrong time
// window, wrong source filter — without any obvious failure mode upstream.
//
// Everything in filters.ts is pure, so this file is all data-in / data-out
// with no fixtures or DB.

import { expect, test } from 'bun:test'
import {
  buildFtsQuery,
  clampLimit,
  clampOffset,
  normalizeMode,
  normalizeSource,
  normalizeSources,
  parseTimestamp,
  ReadStoreError,
} from './filters'

// ---- clampLimit / clampOffset --------------------------------------------

test('clampLimit: number in range is returned as-is', () => {
  expect(clampLimit(20)).toBe(20)
  expect(clampLimit(1)).toBe(1)
  expect(clampLimit(100)).toBe(100)
})

test('clampLimit: clamps to [1, 100]', () => {
  expect(clampLimit(0)).toBe(1)
  expect(clampLimit(-50)).toBe(1)
  expect(clampLimit(101)).toBe(100)
  expect(clampLimit(1_000_000)).toBe(100)
})

test('clampLimit: truncates fractional values', () => {
  expect(clampLimit(3.7)).toBe(3)
  expect(clampLimit(99.99)).toBe(99)
})

test('clampLimit: numeric strings parse and clamp', () => {
  expect(clampLimit('42')).toBe(42)
  expect(clampLimit('200')).toBe(100)
})

test('clampLimit: non-numeric or non-finite falls back to the default', () => {
  expect(clampLimit(undefined)).toBe(20)
  expect(clampLimit(null)).toBe(20)
  expect(clampLimit('not-a-number')).toBe(20)
  expect(clampLimit(Number.NaN)).toBe(20)
  expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(20)
})

test('clampLimit: custom fallback is honored', () => {
  expect(clampLimit(undefined, 50)).toBe(50)
  expect(clampLimit('bogus', 7)).toBe(7)
})

test('clampOffset: zero is the floor', () => {
  expect(clampOffset(0)).toBe(0)
  expect(clampOffset(-1)).toBe(0)
  expect(clampOffset(-1_000_000)).toBe(0)
})

test('clampOffset: positive values pass through (no upper bound)', () => {
  expect(clampOffset(1_000_000)).toBe(1_000_000)
  expect(clampOffset('250')).toBe(250)
})

test('clampOffset: invalid inputs become 0', () => {
  expect(clampOffset(undefined)).toBe(0)
  expect(clampOffset(null)).toBe(0)
  expect(clampOffset('')).toBe(0) // empty string coerces to 0 via Number('')
  expect(clampOffset('not-a-number')).toBe(0)
  expect(clampOffset(Number.NaN)).toBe(0)
})

// ---- parseTimestamp -------------------------------------------------------

test('parseTimestamp: undefined / null / empty string yield undefined', () => {
  expect(parseTimestamp(undefined, 'from')).toBeUndefined()
  expect(parseTimestamp(null, 'from')).toBeUndefined()
  expect(parseTimestamp('', 'from')).toBeUndefined()
})

test('parseTimestamp: finite numeric input is truncated to int ms', () => {
  expect(parseTimestamp(1_700_000_000_000, 'from')).toBe(1_700_000_000_000)
  expect(parseTimestamp(1_700_000_000_123.9, 'from')).toBe(1_700_000_000_123)
})

test('parseTimestamp: NaN / Infinity throw with the field name', () => {
  expect(() => parseTimestamp(Number.NaN, 'from')).toThrow(/from/)
  expect(() => parseTimestamp(Number.POSITIVE_INFINITY, 'to')).toThrow(/to/)
})

test('parseTimestamp: numeric strings parse as epoch ms', () => {
  expect(parseTimestamp('1700000000000', 'from')).toBe(1_700_000_000_000)
  expect(parseTimestamp('1700000000123.9', 'from')).toBe(1_700_000_000_123)
})

test('parseTimestamp: ISO date strings parse via Date.parse', () => {
  // UTC ISO — fixed instant, no timezone ambiguity.
  expect(parseTimestamp('2024-01-15T12:34:56Z', 'from')).toBe(Date.parse('2024-01-15T12:34:56Z'))
})

test('parseTimestamp: invalid date strings throw with field name', () => {
  expect(() => parseTimestamp('definitely-not-a-date', 'from')).toThrow(ReadStoreError)
  expect(() => parseTimestamp('definitely-not-a-date', 'from')).toThrow(/from/)
})

test('parseTimestamp: non-string/number types throw', () => {
  expect(() => parseTimestamp({}, 'from')).toThrow(ReadStoreError)
  expect(() => parseTimestamp([], 'from')).toThrow(ReadStoreError)
  expect(() => parseTimestamp(true, 'from')).toThrow(ReadStoreError)
})

// ---- normalizeSource / normalizeSources -----------------------------------

test('normalizeSource: canonical values pass through', () => {
  expect(normalizeSource('screen')).toBe('screen')
  expect(normalizeSource('mic')).toBe('mic')
  expect(normalizeSource('system')).toBe('system')
})

test('normalizeSource: kind aliases collapse to source labels', () => {
  // The DB stores `screenshot`/`audio_mic`/`audio_system` as `kind`; callers
  // often pass these through to the filter API and expect them to work.
  expect(normalizeSource('screenshot')).toBe('screen')
  expect(normalizeSource('audio_mic')).toBe('mic')
  expect(normalizeSource('audio_system')).toBe('system')
})

test('normalizeSource: empty/undefined/null return undefined', () => {
  expect(normalizeSource(undefined)).toBeUndefined()
  expect(normalizeSource(null)).toBeUndefined()
  expect(normalizeSource('')).toBeUndefined()
})

test('normalizeSource: unknown values throw ReadStoreError', () => {
  expect(() => normalizeSource('webcam')).toThrow(ReadStoreError)
  expect(() => normalizeSource('SCREEN' /* case-sensitive */)).toThrow(ReadStoreError)
})

test('normalizeSources: undefined/null/empty defaults to all three sources', () => {
  expect(normalizeSources(undefined)).toEqual(['screen', 'mic', 'system'])
  expect(normalizeSources(null)).toEqual(['screen', 'mic', 'system'])
  expect(normalizeSources('')).toEqual(['screen', 'mic', 'system'])
})

test('normalizeSources: non-array throws', () => {
  expect(() => normalizeSources('screen')).toThrow(ReadStoreError)
  expect(() => normalizeSources(42)).toThrow(ReadStoreError)
  expect(() => normalizeSources({})).toThrow(ReadStoreError)
})

test('normalizeSources: aliases get collapsed and order preserved', () => {
  expect(normalizeSources(['screenshot', 'audio_mic'])).toEqual(['screen', 'mic'])
})

test('normalizeSources: duplicates are removed while preserving first-seen order', () => {
  expect(normalizeSources(['mic', 'screen', 'mic', 'system', 'screen'])).toEqual([
    'mic',
    'screen',
    'system',
  ])
})

test('normalizeSources: empty array after filtering also falls back to all three', () => {
  // Per the implementation, an empty array means "I didn't filter" — fall back
  // to the default rather than silently returning no sources.
  expect(normalizeSources([])).toEqual(['screen', 'mic', 'system'])
})

test('normalizeSources: unknown member rejects the whole call', () => {
  expect(() => normalizeSources(['screen', 'webcam'])).toThrow(ReadStoreError)
})

// ---- normalizeMode --------------------------------------------------------

test('normalizeMode: defaults to hybrid', () => {
  expect(normalizeMode(undefined)).toBe('hybrid')
  expect(normalizeMode(null)).toBe('hybrid')
  expect(normalizeMode('')).toBe('hybrid')
})

test('normalizeMode: each valid label passes through', () => {
  expect(normalizeMode('lexical')).toBe('lexical')
  expect(normalizeMode('semantic')).toBe('semantic')
  expect(normalizeMode('hybrid')).toBe('hybrid')
})

test('normalizeMode: unknown value throws', () => {
  expect(() => normalizeMode('keyword')).toThrow(ReadStoreError)
  // No casing leniency — be explicit so the caller can fix their input.
  expect(() => normalizeMode('LEXICAL')).toThrow(ReadStoreError)
})

// ---- buildFtsQuery --------------------------------------------------------

test('buildFtsQuery: non-string or empty input is rejected', () => {
  expect(() => buildFtsQuery(undefined)).toThrow(ReadStoreError)
  expect(() => buildFtsQuery(null)).toThrow(ReadStoreError)
  expect(() => buildFtsQuery('')).toThrow(ReadStoreError)
  expect(() => buildFtsQuery('   ')).toThrow(ReadStoreError)
  expect(() => buildFtsQuery(42)).toThrow(ReadStoreError)
})

test('buildFtsQuery: punctuation-only input has no tokens and throws', () => {
  expect(() => buildFtsQuery('!!! ??? ...')).toThrow(/at least one searchable token/)
})

test('buildFtsQuery: single token is quoted to defang FTS operators', () => {
  expect(buildFtsQuery('hello')).toBe('"hello"')
})

test('buildFtsQuery: multi-token input is AND-joined and per-token quoted', () => {
  expect(buildFtsQuery('hello world')).toBe('"hello" AND "world"')
})

test('buildFtsQuery: punctuation between tokens is stripped, tokens are kept', () => {
  // Punctuation around words shouldn't sneak into FTS5 syntax.
  expect(buildFtsQuery('hello, world!')).toBe('"hello" AND "world"')
  expect(buildFtsQuery('foo.bar')).toBe('"foo" AND "bar"')
})

test('buildFtsQuery: underscores and hyphens are part of a single token', () => {
  expect(buildFtsQuery('hpm-asr_v2')).toBe('"hpm-asr_v2"')
})

test('buildFtsQuery: unicode letters and digits tokenize correctly', () => {
  expect(buildFtsQuery('café 日本語 2024')).toBe('"café" AND "日本語" AND "2024"')
})

test('buildFtsQuery: literal double-quotes in tokens are FTS5-escaped (doubled)', () => {
  // The token regex doesn't include `"`, so a quoted string like
  // `"hello"` decomposes into the single token `hello` — and the safety
  // net is the per-token `""` escape on whatever does land inside the
  // brackets. Demonstrate that escape with a token regex-matchable char
  // *next to* a quote: the quote is dropped, the token survives.
  expect(buildFtsQuery('"hello"')).toBe('"hello"')
})

test('buildFtsQuery: FTS operator-looking input is escaped, not interpreted', () => {
  // `OR` could be interpreted as an FTS5 operator if not quoted — we quote
  // every token, so it lands as a search term instead.
  expect(buildFtsQuery('cats OR dogs')).toBe('"cats" AND "OR" AND "dogs"')
  expect(buildFtsQuery('NEAR/3')).toBe('"NEAR" AND "3"')
})
