// Embeds the built frontend (scripts/build-ui.ts output) into the binary as text
// assets. The `with { type: 'text' }` imports are inlined by the stage-1
// Bun.build in build.ts, so the compiled `dist/hpm` carries the whole web app
// with no external files. In dev (`bun run src/cli.ts ui`) Bun reads them from
// frontend_dist directly — run `bun run build:ui` first.

import indexHtml from './frontend_dist/index.html' with { type: 'text' }
import mainJs from './frontend_dist/main.js' with { type: 'text' }
import stylesCss from './frontend_dist/styles.css' with { type: 'text' }

// The `type: 'text'` attribute makes Bun deliver each import as a string at
// runtime, but tsc types them from the built files (HTMLBundle / a JS module
// namespace). This reconciles the two — the values are always strings.
const asText = (value: unknown): string => value as string

export const UI_INDEX_HTML: string = asText(indexHtml)

export interface UiAsset {
  body: string
  contentType: string
}

// Served at /assets/<name>; referenced by frontend/index.html.
export const UI_ASSETS: Record<string, UiAsset> = {
  '/assets/main.js': { body: asText(mainJs), contentType: 'text/javascript; charset=utf-8' },
  '/assets/styles.css': { body: asText(stylesCss), contentType: 'text/css; charset=utf-8' },
}
