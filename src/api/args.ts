// Argument coercion/validation helpers shared by the REST route handlers.
// Each reads a loosely-typed query-string value and either returns a
// normalized value or throws a ReadStoreError that the dispatcher turns into
// a 400 response.
import { ReadStoreError } from './read_store'

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function boolArg(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

export function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new ReadStoreError(`${key} is required`)
  return value
}

export function rejectUnknownArgs(
  args: Record<string, unknown>,
  toolName: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new ReadStoreError(`${toolName} does not accept argument(s): ${unknown.join(', ')}`)
  }
}

export function validateRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && to !== undefined && to < from) {
    throw new ReadStoreError('to must be greater than or equal to from')
  }
}
