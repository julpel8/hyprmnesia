// Builds the local web-app frontend (React SPA) into src/ui/frontend_dist/.
// The outputs — main.js, styles.css, index.html — are embedded into the compiled
// binary as text assets by src/ui/assets.ts, so this must run before the stage-1
// Bun.build in build.ts. Run standalone with `bun run build:ui` (add --watch for
// a rebuild-on-change dev loop).

import { watch } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'

const SRC_DIR = 'src/ui/frontend'
const OUT_DIR = 'src/ui/frontend_dist'

async function build(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  const result = await Bun.build({
    entrypoints: [`${SRC_DIR}/main.tsx`, `${SRC_DIR}/styles.css`],
    outdir: OUT_DIR,
    target: 'browser',
    format: 'esm',
    minify: true,
    // Fixed output names (no content hash): the server serves and the binary
    // embeds them by a stable path.
    naming: '[name].[ext]',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new AggregateError(result.logs, 'frontend build failed')
  }
  await cp(`${SRC_DIR}/index.html`, `${OUT_DIR}/index.html`)
  const names = result.outputs.map((o) => o.path.split('/').pop()).join(', ')
  console.log(`built frontend → ${OUT_DIR} (${names}, index.html)`)
}

await build()

if (process.argv.includes('--watch')) {
  console.log(`watching ${SRC_DIR} for changes…`)
  let pending: ReturnType<typeof setTimeout> | undefined
  watch(SRC_DIR, { recursive: true }, () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      build().catch((err) => console.error(err))
    }, 100)
  })
  // Keep the process alive.
  await new Promise(() => {})
}
