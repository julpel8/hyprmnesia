import type { WindowContext } from '../core/events'

export function windowChanged(a: WindowContext | undefined, b: WindowContext | undefined): boolean {
  if (!a && !b) return false
  if (!a || !b) return true
  return a.app !== b.app || a.title !== b.title || a.url !== b.url
}
