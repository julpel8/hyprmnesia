// step 1: bundle src/cli.ts to dist/bundle.mjs.
// step 2: shell out to `bun build --compile dist/bundle.mjs` to produce dist/hpm.
//
// the plugin handles known bundler quirks:
//
// 1. stub optional deps that are dynamically required but never used:
//    - mock-aws-s3 / aws-sdk / nock : node-pre-gyp uses them only when
//      republishing prebuilt binaries to S3
//    without stubs, --compile produces a binary that tries to resolve them
//    at startup.
//
// 2. copy get-windows' native addon next to the executable. `get-windows`
//    normally asks node-pre-gyp to locate the addon via its package.json, but
//    `import.meta.url` points inside Bun's virtual executable filesystem after
//    --compile, so the package-relative lookup cannot work there.
//
// 3. build native helpers as sibling executables in dist/native/:
//    - hpm-tray: tray supervisor (uses windows_subsystem="windows" — no console).
//    - hpm-ocr : OCR helper, writes JSON to stdout (must be a console binary).
//    - hpm-asr : Parakeet live ASR helper, speaks NDJSON over stdio.
//    - hpm-sck : macOS ScreenCaptureKit helper (system audio + screen frames),
//                NDJSON over stdio. Built everywhere by `cargo --workspace`
//                but only copied into dist/native on darwin (no-op stub
//                elsewhere).
//    - hpm-wasapi : Windows WASAPI loopback helper, writes raw s16le mono PCM
//                to stdout. Built everywhere by `cargo --workspace` but only
//                copied into dist/native on win32 (no-op stub elsewhere).
//    All crates live in a single Cargo workspace at the repo root so we build
//    them in one cargo invocation.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { $ } from 'bun'
import ffmpegStaticPath from 'ffmpeg-static'

const STUBS = new Set(['mock-aws-s3', 'aws-sdk', 'nock'])
const APP_NAME = 'Hyprmnesia'
const WINDOWS_APP_DESCRIPTION = 'Local-first screen and audio memory for desktop assistants'
const GET_WINDOWS_NATIVE_SRC = resolve(
  './node_modules/get-windows/lib/binding/napi-9-win32-unknown-x64/node-get-windows.node',
)
const GET_WINDOWS_NATIVE_DEST = resolve('./dist/native/node-get-windows.node')
const WINDOWS_APP_ICON = resolve('./assets/brand/hyprmnesia.ico')
const FFMPEG_STATIC_SRC =
  typeof ffmpegStaticPath === 'string' ? resolve(ffmpegStaticPath) : undefined
const EXE = process.platform === 'win32' ? '.exe' : ''
const NATIVE_BINS: readonly string[] = [
  'hpm-tray',
  'hpm-ocr',
  'hpm-asr',
  'hpm-embed',
  ...(process.platform === 'darwin' ? ['hpm-sck'] : []),
  ...(process.platform === 'win32' ? ['hpm-wasapi'] : []),
  ...(process.platform === 'linux' ? ['hpm-wlcap'] : []),
]
const NATIVE_DEST_DIR = resolve('./dist/native')

// Pinned sqlite-vec loadable extension. Powers semantic/hybrid MCP search; when
// it can't be fetched the index simply stays FTS5-only, so this step is
// best-effort and never fails the build.
const SQLITE_VEC_VERSION = 'v0.1.6'

// Build the web-app frontend first so src/ui/frontend_dist/* exists for the
// `with { type: 'text' }` imports inlined into the bundle below.
await $`bun run scripts/build-ui.ts`

const bundle = await Bun.build({
  entrypoints: ['./src/cli.ts'],
  outdir: './dist',
  naming: 'bundle.mjs',
  target: 'bun',
  format: 'esm',
  plugins: [
    {
      name: 'patch-deps',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (STUBS.has(args.path)) return { path: args.path, namespace: 'stub' }
          return undefined
        })
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default {}; export const __stubbed = true;',
          loader: 'js',
        }))
      },
    },
  ],
})

if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

if (process.platform === 'win32') {
  if (!existsSync(WINDOWS_APP_ICON)) throw new Error(`missing app icon: ${WINDOWS_APP_ICON}`)
  await $`bun build --compile ./dist/bundle.mjs --outfile ./dist/hpm --windows-icon=${WINDOWS_APP_ICON} --windows-title=${APP_NAME} --windows-publisher=${APP_NAME} --windows-description=${WINDOWS_APP_DESCRIPTION}`
} else {
  await $`bun build --compile ./dist/bundle.mjs --outfile ./dist/hpm`
}

if (process.platform === 'win32' && existsSync(GET_WINDOWS_NATIVE_SRC)) {
  await mkdir(dirname(GET_WINDOWS_NATIVE_DEST), { recursive: true })
  await copyFile(GET_WINDOWS_NATIVE_SRC, GET_WINDOWS_NATIVE_DEST)
}

await $`cargo build --release --workspace`
await mkdir(NATIVE_DEST_DIR, { recursive: true })
if (process.platform !== 'linux' && FFMPEG_STATIC_SRC && existsSync(FFMPEG_STATIC_SRC)) {
  await copyFile(FFMPEG_STATIC_SRC, resolve(NATIVE_DEST_DIR, `ffmpeg${EXE}`))
}
for (const name of NATIVE_BINS) {
  const file = `${name}${EXE}`
  const src = resolve(`./target/release/${file}`)
  if (!existsSync(src)) throw new Error(`cargo did not produce ${src}`)
  await copyFile(src, resolve(NATIVE_DEST_DIR, file))
  await rm(resolve(`./dist/${file}`), { force: true })
}

for (const name of await readdir(resolve('./target/release')).catch(() => [])) {
  if (/^(onnxruntime|DirectML)/i.test(name)) {
    await copyFile(resolve('./target/release', name), resolve(NATIVE_DEST_DIR, name))
  }
}

await fetchSqliteVec()

console.log(`built dist/hpm with native helpers: ${NATIVE_BINS.join(', ')}`)

async function fetchSqliteVec(): Promise<void> {
  const lib = vecLibName()
  const dest = resolve(NATIVE_DEST_DIR, lib)
  if (existsSync(dest)) return
  const platform = sqliteVecPlatform()
  if (!platform) {
    console.warn(`sqlite-vec: unsupported platform ${process.platform}/${process.arch}; skipping`)
    return
  }
  const asset = `sqlite-vec-${SQLITE_VEC_VERSION.slice(1)}-loadable-${platform}.tar.gz`
  const url = `https://github.com/asg017/sqlite-vec/releases/download/${SQLITE_VEC_VERSION}/${asset}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const tmp = resolve('./dist', asset)
    await Bun.write(tmp, await res.arrayBuffer())
    await $`tar -xzf ${tmp} -C ${NATIVE_DEST_DIR} ${lib}`
    await rm(tmp, { force: true })
    console.log(`fetched sqlite-vec ${SQLITE_VEC_VERSION} (${lib})`)
  } catch (err) {
    console.warn(`sqlite-vec: download failed (${String(err)}); semantic search disabled`)
  }
}

function vecLibName(): string {
  if (process.platform === 'win32') return 'vec0.dll'
  if (process.platform === 'darwin') return 'vec0.dylib'
  return 'vec0.so'
}

function sqliteVecPlatform(): string | undefined {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined
  if (!arch) return undefined
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'darwin') return `macos-${arch}`
  if (process.platform === 'win32' && arch === 'x86_64') return 'windows-x86_64'
  return undefined
}
