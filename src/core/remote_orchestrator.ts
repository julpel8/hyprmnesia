import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { type Config, loadConfigForEditing } from '../config'
import { selfCliArgs } from '../util/selfCli'
import { isDaemonAlive, LOG_FILE, readLevels } from './daemon'
import type { CaptureEvent, Source, WindowContext } from './events'
import { EventBus } from './events'
import type { Orchestrator, OrchestratorStatus, SourceStatus } from './orchestrator'

const TAIL_INTERVAL_MS = 100
const LEVELS_INTERVAL_MS = 100

export function makeRemoteOrchestrator(): Orchestrator {
  const events = new EventBus()

  // Mirror the in-process orchestrator's status derivation by subscribing to
  // our own bus. enabled defaults to true since the daemon owns the config;
  // a source that never emits "started" simply renders as "stopped".
  const sources: Record<Source, SourceStatus> = {
    screen: { enabled: true, running: false },
    mic: { enabled: true, running: false },
    system: { enabled: true, running: false },
  }
  let focusedWindow: WindowContext | undefined

  // The daemon owns capture config; reflect the persisted enabled flags so a
  // source toggled off renders as "disabled" rather than merely "stopped".
  const readEnabledFromConfig = (): Record<Source, boolean> => {
    try {
      const cfg = loadConfigForEditing()
      return {
        screen: cfg.capture.screen.enabled,
        mic: cfg.capture.audio.mic.enabled,
        system: cfg.capture.audio.system.enabled,
      }
    } catch {
      return { screen: true, mic: true, system: true }
    }
  }

  const clearSourceState = () => {
    for (const source of Object.values(sources)) {
      source.running = false
      source.started_at = undefined
    }
  }

  // Waits for the CLI child to exit: `hpm stop` only returns once the daemon is
  // actually gone (or SIGKILLed after its grace period), so stop/restart flows
  // can't race a new daemon against one still shutting down. Detached keeps the
  // child out of our process group so Ctrl-C on the caller doesn't abort a stop
  // mid-flight.
  const runCli = (command: string, extra: string[] = []): Promise<void> => {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, selfCliArgs(command, extra), {
        detached: true,
        stdio: 'ignore',
      })
      proc.once('error', reject)
      proc.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`hpm ${command} exited with code ${code}`))
      })
    })
  }

  events.subscribe((e) => {
    if (e.type === 'started') {
      sources[e.source].running = true
      sources[e.source].started_at = e.at
      sources[e.source].last_error = undefined
    } else if (e.type === 'stopped') {
      sources[e.source].running = false
      sources[e.source].started_at = undefined
    } else if (e.type === 'chunk') {
      sources[e.source].last_chunk_at = e.at
      sources[e.source].last_chunk_bytes = e.bytes
      sources[e.source].last_error = undefined
    } else if (e.type === 'error') {
      sources[e.source].last_error = e.message
    } else if (e.type === 'window_changed') {
      focusedWindow = e.window
    }
  })

  // Start tailing the daemon log from its current end so we don't replay history.
  let position = 0
  try {
    position = statSync(LOG_FILE).size
  } catch {
    // Log file may not exist yet; tail will pick up once the daemon writes.
  }

  const tailTimer = setInterval(() => {
    try {
      const stats = statSync(LOG_FILE)
      if (stats.size < position) position = 0 // rotated
      if (stats.size === position) return
      const fd = openSync(LOG_FILE, 'r')
      const buf = Buffer.alloc(stats.size - position)
      readSync(fd, buf, 0, buf.length, position)
      closeSync(fd)
      position = stats.size
      const text = buf.toString('utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          events.publish(JSON.parse(line) as CaptureEvent)
        } catch {
          // skip corrupted line (e.g. partial write on daemon crash)
        }
      }
    } catch {
      // file disappeared during rotation; retry next tick
    }
  }, TAIL_INTERVAL_MS)

  // audio_level events are kept out of the daemon log (too noisy). Synthesise
  // them from levels.json so App.tsx's existing meter code works unchanged.
  const levelsTimer = setInterval(() => {
    const { mic, system } = readLevels()
    const at = Date.now()
    events.publish({ type: 'audio_level', source: 'mic', at, rms_db: mic })
    events.publish({ type: 'audio_level', source: 'system', at, rms_db: system })
  }, LEVELS_INTERVAL_MS)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearInterval(tailTimer)
    clearInterval(levelsTimer)
  }

  return {
    events,
    cfg: undefined as unknown as Config,
    start: async () => {
      await runCli('_daemon')
    },
    stop: async () => {
      clearSourceState()
      await runCli('stop')
    },
    isRunning: () => isDaemonAlive(),
    status: (): OrchestratorStatus => {
      const alive = isDaemonAlive()
      const enabled = readEnabledFromConfig()
      return {
        running: alive,
        sources: {
          screen: {
            ...sources.screen,
            enabled: enabled.screen,
            running: alive && sources.screen.running,
          },
          mic: { ...sources.mic, enabled: enabled.mic, running: alive && sources.mic.running },
          system: {
            ...sources.system,
            enabled: enabled.system,
            running: alive && sources.system.running,
          },
        },
        focused_window: focusedWindow,
      }
    },
    dispose,
  }
}
