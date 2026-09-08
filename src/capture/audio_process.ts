// Capture-process selection and lifecycle: wraps the ffmpeg PCM capture
// process with a graceful-then-forced shutdown.
import type { AudioStreamConfig } from '../config'
import type { AudioSource, EventBus } from '../core/events'
import { buildMicInputArgs, buildSystemAudioInputArgs, getFfmpegPath } from './ffmpeg'

const PCM_PROCESS_STOP_GRACE_MS = 3_000

export interface ResolvedPcmSource {
  bin: string
  args: string[]
  device: string
  label: 'ffmpeg'
}

interface KillableProcess {
  exited: Promise<number>
  kill: (signal?: number | NodeJS.Signals) => void
}

export interface ProcessShutdown {
  exited: Promise<number | undefined>
  terminate: () => void
}

function safeKill(proc: KillableProcess, signal?: NodeJS.Signals): void {
  try {
    if (signal === undefined) proc.kill()
    else proc.kill(signal)
  } catch {}
}

export function makeProcessShutdown(
  proc: KillableProcess,
  label: string,
  source: AudioSource,
  events: EventBus,
  graceMs = PCM_PROCESS_STOP_GRACE_MS,
): ProcessShutdown {
  let terminating = false
  let exitedAlready = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const clearForceTimer = () => {
    if (forceTimer === undefined) return
    clearTimeout(forceTimer)
    forceTimer = undefined
  }
  const exited = proc.exited.catch(() => undefined)
  void exited.then(() => {
    exitedAlready = true
    clearForceTimer()
  })

  return {
    exited,
    terminate: () => {
      if (terminating || exitedAlready) return
      terminating = true
      safeKill(proc)
      forceTimer = setTimeout(() => {
        events.publish({
          type: 'log',
          at: Date.now(),
          level: 'warn',
          message: `${label} (${source}) did not exit after ${graceMs}ms; sending SIGKILL`,
        })
        safeKill(proc, 'SIGKILL')
      }, graceMs)
    },
  }
}

function inputArgsFor(source: AudioSource, device: string): string[] {
  return source === 'mic' ? buildMicInputArgs(device) : buildSystemAudioInputArgs(device)
}

function ffmpegPcmArgs(inputArgs: string[], sampleRate: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...inputArgs,
    '-vn',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    'pipe:1',
  ]
}

// Decide which process produces the PCM stream for a stream config.
export async function resolvePcmSource(
  source: AudioSource,
  stream: AudioStreamConfig,
  sampleRate: number,
): Promise<ResolvedPcmSource> {
  return {
    bin: getFfmpegPath(),
    args: ffmpegPcmArgs(inputArgsFor(source, stream.device), sampleRate),
    device: stream.device,
    label: 'ffmpeg',
  }
}
