// Left-pad a number with zeros to `width` digits (default 2). Used for clock,
// date, and partition-path formatting across the codebase.
export function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

// Compact human duration, e.g. "5m" or "1h23". Rounds to whole minutes.
export function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}`
}
