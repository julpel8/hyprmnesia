// Capture-process selection and lifecycle: picks the binary that produces the
// raw PCM stream for a given source (ffmpeg, or the hpm-wasapi loopback helper
// on Windows) and wraps it with a graceful-then-forced shutdown. ffmpeg and
// hpm-wasapi both emit s16le mono at the requested sample rate on stdout, so the
// downstream consumer is identical regardless of which is chosen.
import type { AudioStreamConfig } from '../config'
import type { AudioSource, EventBus } from '../core/events'
import {
  buildMicInputArgs,
  buildSystemAudioInputArgs,
  buildWasapiArgs,
  findWasapiBinary,
  getFfmpegPath,
  listAvfoundationAudioDevices,
  listDshowAudioDevices,
  SYSTEM_AUDIO_DSHOW_DEVICE,
} from './ffmpeg'

const SCR_INSTALL_URL =
  'https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases'
const PCM_PROCESS_STOP_GRACE_MS = 3_000
const DARWIN_VIRTUAL_MIC_PATTERNS = [/blackhole/i, /aggregate/i, /soundflower/i, /loopback/i]

export interface ResolvedPcmSource {
  bin: string
  args: string[]
  device: string
  label: 'ffmpeg' | 'hpm-wasapi'
  backend?: string
  warn?: string
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

async function resolveDevice(source: AudioSource, configured: string): Promise<string> {
  if (process.platform === 'darwin') {
    if (source !== 'mic' || configured !== 'default') return configured
    // avfoundation `:0` indexes audio devices in registration order; if a
    // virtual loopback device (BlackHole / Aggregate / etc.) is installed it
    // can occupy index 0 and silently feed us silence. Pick the first
    // real-looking input device instead.
    const devices = await listAvfoundationAudioDevices()
    if (devices.length === 0) return '0'
    const real = devices.find((d) => !DARWIN_VIRTUAL_MIC_PATTERNS.some((re) => re.test(d.name)))
    const chosen = real ?? devices[0]
    return String(chosen?.index ?? 0)
  }
  if (process.platform !== 'win32') return configured
  const devices = await listDshowAudioDevices()
  if (source === 'mic') {
    if (configured !== 'default') return configured
    const first = devices.find((d) => !d.toLowerCase().includes(SYSTEM_AUDIO_DSHOW_DEVICE))
    if (!first) throw new Error('no mic device found via dshow')
    return first
  }
  const target = configured === 'default' ? SYSTEM_AUDIO_DSHOW_DEVICE : configured
  const present = devices.some((d) => d.toLowerCase() === target.toLowerCase())
  if (!present) {
    throw new Error(
      `system audio device '${target}' not found via dshow - ` +
        `install Screen Capturer Recorder (free, open source) from ${SCR_INSTALL_URL} ` +
        `or pass --no-system-audio to disable. ` +
        `available dshow audio devices: ${JSON.stringify(devices)}`,
    )
  }
  return target
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

// Decide which process produces the PCM stream for a stream config. Only the
// Windows *system* stream has a backend choice; everything else stays on ffmpeg.
export async function resolvePcmSource(
  source: AudioSource,
  stream: AudioStreamConfig,
  sampleRate: number,
): Promise<ResolvedPcmSource> {
  if (process.platform === 'win32' && source === 'system') {
    const backend = stream.backend ?? 'auto'
    if (backend !== 'dshow') {
      const bin = findWasapiBinary()
      if (bin) {
        return {
          bin,
          args: buildWasapiArgs(stream.device, sampleRate),
          device: stream.device === 'default' ? 'loopback (default render)' : stream.device,
          label: 'hpm-wasapi',
          backend: 'wasapi',
        }
      }
      if (backend === 'wasapi') {
        throw new Error(
          'system audio backend=wasapi but the hpm-wasapi helper was not found - ' +
            'build it with `bun run build` (or `cargo build --release --workspace`), ' +
            'switch backend to dshow, or pass --no-system-audio',
        )
      }
      // auto + helper missing: fall through to dshow with a warning.
    }
    const device = await resolveDevice(source, stream.device)
    return {
      bin: getFfmpegPath(),
      args: ffmpegPcmArgs(inputArgsFor(source, device), sampleRate),
      device,
      label: 'ffmpeg',
      backend: 'dshow',
      warn:
        'system audio using DirectShow (virtual-audio-capturer): capture follows ' +
        'Windows output mute/volume, so muting the speakers silences transcription. ' +
        'Build the hpm-wasapi helper for mute-independent loopback capture.',
    }
  }

  const device = await resolveDevice(source, stream.device)
  return {
    bin: getFfmpegPath(),
    args: ffmpegPcmArgs(inputArgsFor(source, device), sampleRate),
    device,
    label: 'ffmpeg',
  }
}
