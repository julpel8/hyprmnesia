import { expect, test } from 'bun:test'
import { makeTranscription } from './index'
import { normalizeAsrModel } from './native_asr'

// The GPU path needs the servers and models on disk, so the factory tests pin
// device: 'cpu' and check the naming and pairing rules alone.
test('factory builds engine names from the configured family and model', () => {
  expect(makeTranscription({ engine: 'whisper', device: 'cpu' }).name).toBe(
    'whisper:whisper-large-v3-turbo',
  )
  expect(
    makeTranscription({ engine: 'whisper', device: 'cpu', options: { model: 'whisper-small' } })
      .name,
  ).toBe('whisper:whisper-small')
  expect(makeTranscription({ engine: 'parakeet', device: 'cpu' }).name).toBe(
    'parakeet:parakeet-tdt-0.6b-v3',
  )
  expect(makeTranscription({ engine: 'off', device: 'cpu' }).name).toBe('off')
  expect(() => makeTranscription({ engine: 'bogus', device: 'cpu' })).toThrow(
    /unknown transcription engine/,
  )
})

test('normalizeAsrModel keeps known models and falls back per family', () => {
  expect(normalizeAsrModel('whisper', 'whisper-tiny')).toBe('whisper-tiny')
  expect(normalizeAsrModel('whisper', 'whisper-bogus')).toBe('whisper-large-v3-turbo')
  expect(normalizeAsrModel('whisper', 'parakeet-tdt-0.6b-v3')).toBe('whisper-large-v3-turbo')
  expect(normalizeAsrModel('parakeet', 'parakeet-tdt-0.6b-v3')).toBe('parakeet-tdt-0.6b-v3')
  expect(normalizeAsrModel('parakeet', 'whisper-small')).toBe('parakeet-tdt-0.6b-v3')
  expect(normalizeAsrModel('parakeet', undefined)).toBe('parakeet-tdt-0.6b-v3')
})

test('factory pairs a compare engine with the primary one', () => {
  const dual = makeTranscription({
    engine: 'parakeet',
    device: 'cpu',
    compare: { engine: 'whisper', options: { model: 'whisper-small' } },
  })
  expect(dual.name).toBe('parakeet:parakeet-tdt-0.6b-v3+whisper:whisper-small')
})

test('factory returns the primary alone when no compare engine is configured', () => {
  expect(makeTranscription({ engine: 'parakeet', device: 'cpu' }).name).toBe(
    'parakeet:parakeet-tdt-0.6b-v3',
  )
})

test('either family can be the primary engine', () => {
  const dual = makeTranscription({
    engine: 'whisper',
    device: 'cpu',
    options: { model: 'whisper-medium' },
    compare: { engine: 'parakeet' },
  })
  expect(dual.name).toBe('whisper:whisper-medium+parakeet:parakeet-tdt-0.6b-v3')
})
