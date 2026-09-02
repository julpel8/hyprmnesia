export interface WavLevels {
  rms_db: number
  peak_db: number
}

export function pcm16Levels(buf: Buffer): WavLevels {
  const sampleCount = Math.floor(buf.length / 2)
  if (sampleCount === 0) return { rms_db: -Infinity, peak_db: -Infinity }

  let sumSquares = 0
  let peak = 0
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i)
    sumSquares += s * s
    const abs = Math.abs(s)
    if (abs > peak) peak = abs
  }
  const rms = Math.sqrt(sumSquares / sampleCount)
  const rms_db = rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity
  const peak_db = peak > 0 ? 20 * Math.log10(peak / 32768) : -Infinity
  return { rms_db, peak_db }
}

export function encodePcm16Wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
