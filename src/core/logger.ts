import { renameSync, writeFileSync } from 'node:fs'
import type { EventBus } from './events'

export function subscribeNdjsonStdout(events: EventBus): () => void {
  return events.subscribe((e) => {
    // audio_level fires ~60/s per source — too noisy for the log file.
    // The latest values are mirrored to levels.json (see subscribeLevelsFile).
    if (e.type === 'audio_level') return
    process.stdout.write(JSON.stringify(e) + '\n')
  })
}

export function subscribeLevelsFile(events: EventBus, levelsFile: string): () => void {
  const tmpFile = levelsFile + '.tmp'
  let mic = -60
  let system = -60
  let dirty = false

  const unsub = events.subscribe((e) => {
    if (e.type !== 'audio_level') return
    if (e.source === 'mic') mic = Number.isFinite(e.rms_db) ? e.rms_db : -60
    else if (e.source === 'system') system = Number.isFinite(e.rms_db) ? e.rms_db : -60
    dirty = true
  })

  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    try {
      writeFileSync(tmpFile, JSON.stringify({ mic, system, at: Date.now() }))
      renameSync(tmpFile, levelsFile)
    } catch {
      // Best-effort: levels readers fall back to -60 dB on missing/corrupt file.
    }
  }, 100)

  return () => {
    unsub()
    clearInterval(timer)
  }
}
