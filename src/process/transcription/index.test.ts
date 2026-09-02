import { expect, test } from 'bun:test'
import { makeTranscription } from './index'
import { normalizeAsrModel } from './native_asr'

test('factory builds engine names from the configured family and model', () => {
  expect(makeTranscription({ engine: 'whisper' }).name).toBe('whisper:whisper-large-v3-turbo')
  expect(makeTranscription({ engine: 'whisper', options: { model: 'whisper-small' } }).name).toBe(
    'whisper:whisper-small',
  )
  expect(makeTranscription({ engine: 'parakeet' }).name).toBe('parakeet:parakeet-tdt-0.6b-v3')
  expect(makeTranscription({ engine: 'noop' }).name).toBe('noop')
  expect(() => makeTranscription({ engine: 'bogus' })).toThrow(/unknown transcription engine/)
})

test('normalizeAsrModel keeps known models and falls back per family', () => {
  expect(normalizeAsrModel('whisper', 'whisper-tiny')).toBe('whisper-tiny')
  expect(normalizeAsrModel('whisper', 'whisper-bogus')).toBe('whisper-large-v3-turbo')
  expect(normalizeAsrModel('whisper', 'parakeet-tdt-0.6b-v3')).toBe('whisper-large-v3-turbo')
  expect(normalizeAsrModel('parakeet', 'parakeet-tdt-0.6b-v3')).toBe('parakeet-tdt-0.6b-v3')
  expect(normalizeAsrModel('parakeet', 'whisper-small')).toBe('parakeet-tdt-0.6b-v3')
  expect(normalizeAsrModel('parakeet', undefined)).toBe('parakeet-tdt-0.6b-v3')
})
