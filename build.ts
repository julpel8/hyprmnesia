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
// 2. build native helpers as sibling executables in dist/native/:
//    - hpm-tray  : tray supervisor.
//    - hpm-asr   : Parakeet live ASR helper, speaks NDJSON over stdio.
//    - hpm-embed : embedding helper.
//    - hpm-wlcap : Wayland screen/audio capture helper, NDJSON over stdio.
//    All crates live in a single Cargo workspace at the repo root so we build
//    them in one cargo invocation.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { $ } from 'bun'

const STUBS = new Set(['mock-aws-s3', 'aws-sdk', 'nock'])
const NATIVE_BINS: readonly string[] = ['hpm-tray', 'hpm-asr', 'hpm-embed', 'hpm-wlcap']
const NATIVE_DEST_DIR = resolve('./dist/native')

// Pinned sqlite-vec loadable extension. Powers semantic/hybrid MCP search; when
// it can't be fetched the index simply stays FTS5-only, so this step is
// best-effort and never fails the build.
const SQLITE_VEC_VERSION = 'v0.1.6'
const SQLITE_VEC_LIB = 'vec0.so'

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

await $`bun build --compile ./dist/bundle.mjs --outfile ./dist/hpm`

await $`cargo build --release --workspace`
await mkdir(NATIVE_DEST_DIR, { recursive: true })
for (const name of NATIVE_BINS) {
  const src = resolve(`./target/release/${name}`)
  if (!existsSync(src)) throw new Error(`cargo did not produce ${src}`)
  await copyFile(src, resolve(NATIVE_DEST_DIR, name))
  await rm(resolve(`./dist/${name}`), { force: true })
}

for (const name of await readdir(resolve('./target/release')).catch(() => [])) {
  if (/^onnxruntime/i.test(name)) {
    await copyFile(resolve('./target/release', name), resolve(NATIVE_DEST_DIR, name))
  }
}

await fetchSqliteVec()

console.log(`built dist/hpm with native helpers: ${NATIVE_BINS.join(', ')}`)

async function fetchSqliteVec(): Promise<void> {
  const dest = resolve(NATIVE_DEST_DIR, SQLITE_VEC_LIB)
  if (existsSync(dest)) return
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined
  if (!arch) {
    console.warn(`sqlite-vec: unsupported arch ${process.arch}; skipping`)
    return
  }
  const platform = `linux-${arch}`
  const asset = `sqlite-vec-${SQLITE_VEC_VERSION.slice(1)}-loadable-${platform}.tar.gz`
  const url = `https://github.com/asg017/sqlite-vec/releases/download/${SQLITE_VEC_VERSION}/${asset}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const tmp = resolve('./dist', asset)
    await Bun.write(tmp, await res.arrayBuffer())
    await $`tar -xzf ${tmp} -C ${NATIVE_DEST_DIR} ${SQLITE_VEC_LIB}`
    await rm(tmp, { force: true })
    console.log(`fetched sqlite-vec ${SQLITE_VEC_VERSION} (${SQLITE_VEC_LIB})`)
  } catch (err) {
    console.warn(`sqlite-vec: download failed (${String(err)}); semantic search disabled`)
  }
}
