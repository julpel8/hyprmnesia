import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { repairWebpRiffSize } from '../util/webp'

interface FfmpegSearchOptions {
  env?: Record<string, string | undefined>
  execPath?: string
  cwd?: string
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
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  const cwd = opts.cwd ?? process.cwd()
  const binary = 'ffmpeg'
  const paths: string[] = []

  pushUnique(paths, env.HPM_FFMPEG)
  pushUnique(paths, env.FFMPEG_BIN)
  pushUnique(paths, join(dirname(execPath), 'native', binary))
  pushUnique(paths, join(dirname(execPath), binary))
  pushUnique(paths, join(cwd, 'dist', 'native', binary))
  pushUnique(paths, join(cwd, 'dist', binary))

  // Debian/Ubuntu builds enable libpulse by default, which `-f pulse` needs.
  pushUnique(paths, '/usr/bin/ffmpeg')
  pushUnique(paths, '/usr/local/bin/ffmpeg')

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
  throw new Error(
    'ffmpeg not found. Install it (e.g. `sudo apt install ffmpeg`) or set HPM_FFMPEG/FFMPEG_BIN.',
  )
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
    { stdin: pcm, stdout: 'pipe', stderr: 'pipe' },
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

export function buildMicInputArgs(device: string): string[] {
  return ['-f', 'pulse', '-i', device === 'default' ? 'default' : device]
}

export function buildSystemAudioInputArgs(device: string): string[] {
  return ['-f', 'pulse', '-i', device === 'default' ? '@DEFAULT_MONITOR@' : device]
}
