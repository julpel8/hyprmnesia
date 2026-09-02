// Tests for the audio-level math and WAV header construction. Both are
// pure byte-pushing functions: a bug here is silent (wrong dB feeds the
// audioState 'quiet' detector, a wrong RIFF header makes the file
// unplayable) but easy to pin with hand-built fixtures.

import { expect, test } from 'bun:test'
import { encodePcm16Wav, pcm16Levels } from './wav'

// ---- pcm16Levels: dB math -------------------------------------------------

function pcmOf(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] ?? 0, i * 2)
  return buf
}

test('pcm16Levels: empty buffer → -Infinity for both rms and peak', () => {
  const { rms_db, peak_db } = pcm16Levels(Buffer.alloc(0))
  expect(rms_db).toBe(-Infinity)
  expect(peak_db).toBe(-Infinity)
})

test('pcm16Levels: all-zero PCM → -Infinity for rms and peak (silence)', () => {
  const { rms_db, peak_db } = pcm16Levels(pcmOf([0, 0, 0, 0, 0, 0]))
  expect(rms_db).toBe(-Infinity)
  expect(peak_db).toBe(-Infinity)
})

test('pcm16Levels: full-scale square wave → 0 dBFS for both rms and peak', () => {
  // A signal that alternates ±32767 (i16 full-scale) has rms = peak = 32767.
  // 20 log10(32767/32768) ≈ -2.6e-4 dB, well within rounding.
  const samples = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 32767 : -32767))
  const { rms_db, peak_db } = pcm16Levels(pcmOf(samples))
  expect(rms_db).toBeCloseTo(0, 2)
  expect(peak_db).toBeCloseTo(0, 2)
})

test('pcm16Levels: peak_db reflects the loudest single sample, not the average', () => {
  // 1023 zero samples + 1 spike at 32767. Peak is full-scale; rms is way
  // below since most samples are silent.
  const samples = new Array(1024).fill(0)
  samples[42] = 32767
  const { rms_db, peak_db } = pcm16Levels(pcmOf(samples))
  expect(peak_db).toBeCloseTo(0, 2)
  // sqrt(32767^2 / 1024) ≈ 1024 → 20 log10(1024/32768) ≈ -30.1 dB.
  expect(rms_db).toBeCloseTo(-30.1, 0)
})

test('pcm16Levels: negative sample magnitudes contribute to peak_db', () => {
  const samples = new Array(1024).fill(0)
  samples[10] = -32000
  const { peak_db } = pcm16Levels(pcmOf(samples))
  // 20 log10(32000/32768) ≈ -0.21 dB
  expect(peak_db).toBeCloseTo(-0.21, 1)
})

test('pcm16Levels: peak_db is monotonic in the input amplitude', () => {
  const quiet = pcm16Levels(pcmOf(new Array(1024).fill(100))).peak_db
  const loud = pcm16Levels(pcmOf(new Array(1024).fill(10_000))).peak_db
  expect(loud).toBeGreaterThan(quiet)
})

test('pcm16Levels: odd byte length is rounded down (incomplete last sample is dropped)', () => {
  // 3 bytes = 1 complete sample + 1 stray byte. The stray byte must not crash
  // or be read; we should compute as if only one sample exists.
  const buf = Buffer.from([0xff, 0x7f, 0x42]) // sample = 32767, stray 0x42
  const { peak_db } = pcm16Levels(buf)
  // 20 log10(32767/32768) ≈ 0.
  expect(peak_db).toBeCloseTo(0, 2)
})

test('pcm16Levels: a real-world quiet signal stays well below the -75 dB peak gate', () => {
  // Ambient noise around ±10 i16 LSB — typical for a muted mic. Confirms
  // our audioState 'quiet_no_transcript' detector would fire.
  const samples = Array.from({ length: 2048 }, (_, i) => (i % 2 === 0 ? 10 : -10))
  const { peak_db } = pcm16Levels(pcmOf(samples))
  // 20 log10(10/32768) ≈ -70 dB. Confirms low-amplitude detection.
  expect(peak_db).toBeLessThan(-65)
  expect(peak_db).toBeGreaterThan(-75)
})

// ---- encodePcm16Wav: RIFF header structure -------------------------------

test('encodePcm16Wav: emits a 44-byte header followed by the PCM payload', () => {
  const pcm = pcmOf([1, 2, 3, 4])
  const wav = encodePcm16Wav(pcm, 16_000)
  expect(wav.length).toBe(44 + pcm.length)
  // PCM payload is preserved verbatim at offset 44.
  expect(wav.subarray(44).equals(pcm)).toBe(true)
})

test('encodePcm16Wav: header has the canonical RIFF/WAVE/fmt /data marker layout', () => {
  const pcm = pcmOf([0, 0, 0, 0])
  const wav = encodePcm16Wav(pcm, 48_000)
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
  expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
  expect(wav.toString('ascii', 36, 40)).toBe('data')
})

test('encodePcm16Wav: RIFF chunk size = 36 + pcm.length (file_size - 8)', () => {
  const pcm = pcmOf(new Array(100).fill(0))
  const wav = encodePcm16Wav(pcm, 16_000)
  expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
})

test('encodePcm16Wav: fmt chunk encodes PCM mono 16-bit at the supplied rate', () => {
  const pcm = pcmOf([0, 0])
  const wav = encodePcm16Wav(pcm, 16_000)
  expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk size
  expect(wav.readUInt16LE(20)).toBe(1) // audio format = PCM
  expect(wav.readUInt16LE(22)).toBe(1) // num channels = mono
  expect(wav.readUInt32LE(24)).toBe(16_000) // sample rate
  expect(wav.readUInt32LE(28)).toBe(32_000) // byte rate = rate * channels * bytes/sample
  expect(wav.readUInt16LE(32)).toBe(2) // block align
  expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
})

test('encodePcm16Wav: data chunk size matches the PCM byte length', () => {
  const pcm = pcmOf(new Array(50).fill(0))
  const wav = encodePcm16Wav(pcm, 16_000)
  expect(wav.readUInt32LE(40)).toBe(pcm.length)
})

test('encodePcm16Wav: byte_rate scales linearly with the requested sample rate', () => {
  const pcm = Buffer.alloc(0)
  const wav44k = encodePcm16Wav(pcm, 44_100)
  expect(wav44k.readUInt32LE(28)).toBe(88_200)
  const wav48k = encodePcm16Wav(pcm, 48_000)
  expect(wav48k.readUInt32LE(28)).toBe(96_000)
})

test('encodePcm16Wav: empty PCM produces a valid 44-byte header with data size 0', () => {
  const wav = encodePcm16Wav(Buffer.alloc(0), 16_000)
  expect(wav.length).toBe(44)
  expect(wav.readUInt32LE(40)).toBe(0)
  expect(wav.readUInt32LE(4)).toBe(36)
})

test('encodePcm16Wav: output round-trips its own PCM payload exactly', () => {
  const original = pcmOf([100, -100, 1000, -1000, 32767, -32768])
  const wav = encodePcm16Wav(original, 16_000)
  const extracted = wav.subarray(44)
  expect(extracted.length).toBe(original.length)
  for (let i = 0; i < original.length; i++) {
    expect(extracted[i]).toBe(original[i] ?? 0)
  }
})
