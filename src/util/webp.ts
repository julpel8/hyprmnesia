export function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
}

export function hasValidWebpRiffSize(buf: Buffer): boolean {
  if (!isWebp(buf)) return false
  return buf.readUInt32LE(4) === buf.length - 8
}

export function repairWebpRiffSize(buf: Buffer): Buffer {
  if (!isWebp(buf)) return buf
  const size = buf.length - 8
  if (size < 0 || size > 0xffffffff) return buf
  if (buf.readUInt32LE(4) === size) return buf

  const repaired = Buffer.from(buf)
  repaired.writeUInt32LE(size, 4)
  return repaired
}
