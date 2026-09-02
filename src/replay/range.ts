// Parses an HTTP `Range` header for the replay blob endpoint. Encrypted blobs
// are decrypted whole in memory (GCM authenticates the entire file), so we slice
// the plaintext buffer ourselves rather than letting Bun.file serve the range.
//
// Returns inclusive { start, end } byte bounds, or null when there is no Range
// header, the header is malformed, or the range is unsatisfiable — callers then
// serve the full body (200) instead of a partial (206).

export interface ByteRange {
  start: number
  end: number
}

export function sliceRange(
  total: number,
  rangeHeader: string | null | undefined,
): ByteRange | null {
  if (!rangeHeader || total <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix form `bytes=-N`: the final N bytes.
    const n = Number(rawEnd)
    if (n <= 0) return null
    start = Math.max(0, total - n)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= total) return null
  return { start, end }
}
