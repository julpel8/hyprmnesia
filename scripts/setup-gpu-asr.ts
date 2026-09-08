#!/usr/bin/env bun
// Provisions the GPU transcription path: the two ggml/Vulkan servers into
// dist/native/gpu, and their models into ~/.hyprmnesia/gpu-models.
//
// Vulkan is what makes one build reach an Intel, AMD or NVIDIA GPU. parakeet.cpp
// publishes a Vulkan Linux binary, so that one is a download. whisper.cpp does
// not, so it is built here from source; the shader compiler it needs (glslc) is
// unpacked from its .deb into a scratch prefix rather than installed, so no root
// is required.
//
// Usage: bun run scripts/setup-gpu-asr.ts [--models tiny,base,small,medium,...]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const GPU_DIR = join(process.cwd(), 'dist', 'native', 'gpu')
const MODEL_DIR = join(homedir(), '.hyprmnesia', 'gpu-models')
const WORK = join(tmpdir(), 'hpm-gpu-asr-setup')

const PARAKEET_VERSION = 'v0.5.0'
const PARAKEET_TARBALL = `parakeet-${PARAKEET_VERSION}-bin-linux-vulkan-x64.tar.gz`
const WHISPER_VERSION = 'v1.9.3'

const PARAKEET_MODEL_URL =
  'https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/tdt-0.6b-v3-q8_0.gguf'
const PARAKEET_MODEL_FILE = 'parakeet-tdt-0.6b-v3-q8_0.gguf'

// Debian packages carrying the shader toolchain. Unpacked, never installed.
const BUILD_DEBS = ['glslc', 'libshaderc1', 'libvulkan-dev', 'spirv-headers']

function run(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): void {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})`)
}

function capture(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : ''
}

async function download(url: string, target: string): Promise<void> {
  if (existsSync(target)) {
    console.log(`  déjà là: ${target}`)
    return
  }
  console.log(`  ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
  await Bun.write(target, res)
}

async function installParakeet(): Promise<void> {
  console.log('parakeet.cpp (binaire Vulkan officiel)')
  const tarball = join(WORK, PARAKEET_TARBALL)
  await download(
    `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_VERSION}/${PARAKEET_TARBALL}`,
    tarball,
  )
  run('tar', ['xzf', tarball, '-C', WORK])
  const dir = join(WORK, PARAKEET_TARBALL.replace('.tar.gz', ''))
  for (const name of readdirSync(dir)) {
    if (name === 'parakeet-server' || name.includes('.so')) {
      run('cp', ['-P', join(dir, name), GPU_DIR])
    }
  }
}

// glslc, its runtime library, the Vulkan headers and the SPIR-V headers, taken
// from the archive and unpacked into a prefix that only this build sees.
function unpackBuildDeps(prefix: string): void {
  console.log('outils de compilation des shaders (sans sudo)')
  const debs = join(WORK, 'debs')
  mkdirSync(debs, { recursive: true })
  for (const pkg of BUILD_DEBS) {
    const uris = capture('apt-get', ['download', '--print-uris', pkg])
    const url = uris.split(/\s+/)[0]?.replace(/'/g, '')
    if (!url) throw new Error(`cannot resolve a download URL for ${pkg}`)
    run('sh', ['-c', `cd ${debs} && curl -sLO ${url}`])
  }
  for (const name of readdirSync(debs)) {
    if (name.endsWith('.deb')) run('dpkg', ['-x', join(debs, name), prefix])
  }
}

function buildWhisper(prefix: string): void {
  console.log(`whisper.cpp ${WHISPER_VERSION} (compilation Vulkan)`)
  const src = join(WORK, 'whisper.cpp')
  if (!existsSync(src)) {
    run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      WHISPER_VERSION,
      'https://github.com/ggml-org/whisper.cpp.git',
      src,
    ])
  }
  const bin = join(prefix, 'usr', 'bin')
  const lib = join(prefix, 'usr', 'lib', 'x86_64-linux-gnu')
  // glslc is unpacked rather than installed, so it finds neither its own
  // libshaderc nor a system copy without being told where to look. CMake probes
  // glslc for optional shader extensions, and a glslc that fails to launch is
  // read as "extension supported", which then breaks the shader build — so the
  // library path has to be set for configure, not only for the build.
  const env = { PATH: `${bin}:${process.env.PATH}`, LD_LIBRARY_PATH: lib }
  run(
    'cmake',
    [
      '-B',
      'build',
      '-DGGML_VULKAN=1',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DWHISPER_BUILD_TESTS=OFF',
      `-DCMAKE_PREFIX_PATH=${join(prefix, 'usr')}`,
      `-DVulkan_INCLUDE_DIR=${join(prefix, 'usr', 'include')}`,
      '-DVulkan_LIBRARY=/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
      `-DVulkan_GLSLC_EXECUTABLE=${join(bin, 'glslc')}`,
    ],
    src,
    env,
  )
  run('cmake', ['--build', 'build', '-j', String(navigator.hardwareConcurrency || 4)], src, env)

  const built = join(src, 'build', 'bin')
  for (const name of readdirSync(built)) {
    if (name === 'whisper-server' || name.includes('.so')) {
      run('cp', ['-P', join(built, name), GPU_DIR])
    }
  }
}

async function installModels(whisperSizes: string[]): Promise<void> {
  console.log('modèles')
  await download(PARAKEET_MODEL_URL, join(MODEL_DIR, PARAKEET_MODEL_FILE))
  for (const size of whisperSizes) {
    const file = `ggml-${size}.bin`
    await download(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`,
      join(MODEL_DIR, file),
    )
  }
}

const args = process.argv.slice(2)
const modelsArg = args.indexOf('--models')
const whisperSizes =
  modelsArg >= 0 && args[modelsArg + 1] ? (args[modelsArg + 1] as string).split(',') : ['medium']

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    `the GPU ASR path is packaged for linux-x64, not ${process.platform}-${process.arch}`,
  )
}

mkdirSync(GPU_DIR, { recursive: true })
mkdirSync(MODEL_DIR, { recursive: true })
mkdirSync(WORK, { recursive: true })

const prefix = join(WORK, 'prefix')
mkdirSync(prefix, { recursive: true })

await installParakeet()
if (!existsSync(join(GPU_DIR, 'whisper-server'))) {
  unpackBuildDeps(prefix)
  buildWhisper(prefix)
} else {
  console.log('whisper-server déjà installé')
}
await installModels(whisperSizes)

// The clone and the build tree are the bulk of the scratch directory and are
// rebuilt on demand; the downloaded models are kept where the daemon reads them.
rmSync(join(WORK, 'debs'), { recursive: true, force: true })

console.log(`\nbinaires : ${GPU_DIR}`)
console.log(`modèles  : ${MODEL_DIR}`)
console.log('mets `device: gpu` dans processing.transcription pour les utiliser.')
