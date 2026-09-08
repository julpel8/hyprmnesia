import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { repairWebpRiffSize } from '../util/webp'

export const SYSTEM_AUDIO_DSHOW_DEVICE = 'virtual-audio-capturer'

// Locate the native WASAPI loopback helper, mirroring the candidate search used
// for hpm-sck (see capture/sck.ts). Returns undefined when not built/bundled.
export function findWasapiBinary(): string | undefined {
  const name = process.platform === 'win32' ? 'hpm-wasapi.exe' : 'hpm-wasapi'
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'target', 'release', name),
  ]
  return candidates.find((p) => existsSync(p))
}

// hpm-wasapi emits final-format s16le mono PCM itself, so it needs only the
// target rate and an optional device name.
export function buildWasapiArgs(device: string, sampleRate: number): string[] {
  const args = ['--rate', String(sampleRate)]
  if (device && device !== 'default') args.push('--device', device)
  return args
}

interface FfmpegSearchOptions {
  platform?: typeof process.platform
  env?: Record<string, string | undefined>
  execPath?: string
  cwd?: string
  ffmpegStaticPath?: string | null
}

function ffmpegBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

function pushUnique(paths: string[], value: string | undefined | null): void {
  if (!value || paths.includes(value)) return
  paths.push(value)
}

function pathCandidates(envPath: string | undefined, binary: string): string[] {
  if (!envPath) return []
  return envPath
    .split(delimiter)
    .filter((dir) => dir.trim() !== '')
    .map((dir) => join(dir, binary))
}

export function ffmpegSearchPaths(opts: FfmpegSearchOptions = {}): string[] {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  const cwd = opts.cwd ?? process.cwd()
  const staticPath = opts.ffmpegStaticPath ?? ffmpegPath
  const binary = ffmpegBinaryName(platform)
  const paths: string[] = []

  pushUnique(paths, env.HPM_FFMPEG)
  pushUnique(paths, env.FFMPEG_BIN)
  pushUnique(paths, join(dirname(execPath), 'native', binary))
  pushUnique(paths, join(dirname(execPath), binary))
  pushUnique(paths, join(cwd, 'dist', 'native', binary))
  pushUnique(paths, join(cwd, 'dist', binary))

  if (platform === 'linux') {
    // ffmpeg-static on Linux is built without libpulse / libpipewire, so it
    // cannot capture from `-f pulse`. Prefer the system ffmpeg (Debian/Ubuntu
    // builds enable libpulse by default).
    pushUnique(paths, '/usr/bin/ffmpeg')
    pushUnique(paths, '/usr/local/bin/ffmpeg')
  } else {
    pushUnique(paths, staticPath)
  }

  for (const candidate of pathCandidates(env.PATH, binary)) pushUnique(paths, candidate)
  return paths
}

let cachedFfmpegPath: string | null = null

export function getFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath
  const found = ffmpegSearchPaths().find((candidate) => existsSync(candidate))
  if (found) {
    cachedFfmpegPath = found
    return cachedFfmpegPath
  }
  if (process.platform === 'linux') {
    throw new Error(
      'ffmpeg not found on Linux. Install it (e.g. `sudo apt install ffmpeg`) — the bundled ffmpeg-static binary lacks PulseAudio support.',
    )
  }
  throw new Error('ffmpeg binary not found; install ffmpeg or set HPM_FFMPEG/FFMPEG_BIN')
}

export interface ImageQualityOptions {
  format: 'png' | 'jpg' | 'webp'
  quality: number
  maxWidth: number
}

/**
 * Returns true when the configured quality settings require re-encoding the
 * raw screenshot. PNG at native resolution is a pass-through, so default
 * captures never pay the transcode cost.
 */
export function needsImageTranscode(opts: ImageQualityOptions): boolean {
  return opts.maxWidth > 0 || opts.format === 'jpg' || opts.format === 'webp'
}

/**
 * Re-encodes a screenshot through ffmpeg to apply resolution and lossy quality.
 *
 * Used on the capture path, whose helpers emit full-size PNG or JPEG and
 * cannot downscale or set image quality on their own. On any failure the original buffer
 * is returned so capture keeps working even when ffmpeg is unavailable.
 */
export async function transcodeImage(input: Buffer, opts: ImageQualityOptions): Promise<Buffer> {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0']
  if (opts.maxWidth > 0) {
    // -2 keeps the aspect ratio while forcing even dimensions, which mjpeg needs.
    args.push('-vf', `scale='min(${opts.maxWidth},iw)':-2`)
  }
  if (opts.format === 'jpg') {
    const quality = Math.max(1, Math.min(100, Math.trunc(opts.quality)))
    // mjpeg uses qscale 2 (best) to 31 (worst); map 1-100 onto that range.
    const qscale = Math.round(2 + ((100 - quality) / 99) * 29)
    args.push('-q:v', String(qscale), '-f', 'mjpeg')
  } else if (opts.format === 'webp') {
    const quality = Math.max(1, Math.min(100, Math.trunc(opts.quality)))
    args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality), '-f', 'webp')
  } else {
    args.push('-c:v', 'png', '-f', 'image2pipe')
  }
  args.push('pipe:1')

  try {
    const proc = Bun.spawn([getFfmpegPath(), ...args], {
      stdin: input,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const out = Buffer.from(await new Response(proc.stdout).arrayBuffer())
    const exit = await proc.exited
    if (exit !== 0 || out.length === 0) return input
    return opts.format === 'webp' ? repairWebpRiffSize(out) : out
  } catch {
    return input
  }
}

export interface AudioOpusOptions {
  bitrateKbps: number
}

/**
 * Encodes mono signed 16-bit PCM into a WebM/Opus blob for compact replay
 * storage. The capture/ASR path keeps using PCM; this is only for the durable
 * blob written after a chunk is complete.
 */
export async function encodePcm16WebmOpus(
  pcm: Buffer,
  sampleRate: number,
  opts: AudioOpusOptions,
): Promise<Buffer> {
  const bitrateKbps = Math.max(6, Math.min(256, Math.trunc(opts.bitrateKbps)))
  const proc = Bun.spawn(
    [
      getFfmpegPath(),
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-vn',
      '-c:a',
      'libopus',
      '-application',
      'voip',
      '-b:a',
      `${bitrateKbps}k`,
      '-vbr',
      'on',
      '-f',
      'webm',
      'pipe:1',
    ],
    { stdin: pcm, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  const [out, stderr, exit] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const encoded = Buffer.from(out)
  if (exit !== 0 || encoded.length === 0) {
    throw new Error(`ffmpeg opus encode failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
  }
  return encoded
}

export async function listDshowAudioDevices(): Promise<string[]> {
  // FFmpeg is a console binary on Windows; hide its transient console while we
  // query dshow devices in daemon flows.
  const proc = Bun.spawn(
    [getFfmpegPath(), '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const devices: string[] = []
  const re = /"([^"]+)" \(audio\)/g
  let m: RegExpExecArray | null = re.exec(stderr)
  while (m !== null) {
    if (m[1]) devices.push(m[1])
    m = re.exec(stderr)
  }
  return devices
}

export interface AvfoundationAudioDevice {
  index: number
  name: string
}

export async function listAvfoundationAudioDevices(): Promise<AvfoundationAudioDevice[]> {
  const proc = Bun.spawn(
    [getFfmpegPath(), '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const devices: AvfoundationAudioDevice[] = []
  let inAudio = false
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/^\[AVFoundation[^\]]*\]\s*/, '')
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true
      continue
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    const m = line.match(/^\[(\d+)\]\s*(.+?)\s*$/)
    if (m && m[1] && m[2]) devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

export function buildMicInputArgs(device: string): string[] {
  switch (process.platform) {
    case 'win32':
      return ['-f', 'dshow', '-i', `audio=${device}`]
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `:${device === 'default' ? '0' : device}`]
    default:
      return ['-f', 'pulse', '-i', device === 'default' ? 'default' : device]
  }
}

export function buildSystemAudioInputArgs(device: string): string[] {
  switch (process.platform) {
    case 'win32':
      return [
        '-f',
        'dshow',
        '-i',
        `audio=${device === 'default' ? SYSTEM_AUDIO_DSHOW_DEVICE : device}`,
      ]
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `:${device === 'default' ? 'BlackHole 2ch' : device}`]
    default:
      return ['-f', 'pulse', '-i', device === 'default' ? '@DEFAULT_MONITOR@' : device]
  }
}
