// Parse a number|string and clamp it to an integer in [min, max]. Non-finite or
// non-numeric input (including undefined/null) yields `fallback`. This is the
// shared implementation behind clampLimit (read_store/filters.ts), the sync
// server's limit parsing, and the bounded numeric fields in config.ts.
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
