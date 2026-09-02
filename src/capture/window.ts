import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { activeWindow } from 'get-windows'
import type { WindowContext } from '../core/events'
import { readWaylandWindow } from './window_wayland'

export { windowChanged } from './window_context'

interface NativeWindow {
  title?: string
  url?: string
  owner?: {
    name?: string
    processId?: number
  }
}

interface GetWindowsAddon {
  getActiveWindow(): NativeWindow | undefined
}

let packageActiveWindowWorks = true
let bundledAddon: GetWindowsAddon | null | undefined

function loadBundledWindowsAddon(): GetWindowsAddon | undefined {
  if (process.platform !== 'win32') return undefined
  if (bundledAddon !== undefined) return bundledAddon ?? undefined

  const require = createRequire(import.meta.url)
  // Bun's compiled executable rewrites package-relative paths into its virtual
  // filesystem, so get-windows cannot always find its .node addon via node-pre-gyp.
  // Prefer the addon copied next to dist/hpm.exe, then fall back to dev paths.
  const candidates = [
    join(dirname(process.execPath), 'native', 'node-get-windows.node'),
    join(process.cwd(), 'dist', 'native', 'node-get-windows.node'),
    join(
      process.cwd(),
      'node_modules',
      'get-windows',
      'lib',
      'binding',
      'napi-9-win32-unknown-x64',
      'node-get-windows.node',
    ),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    bundledAddon = require(candidate) as GetWindowsAddon
    return bundledAddon
  }

  bundledAddon = null
  return undefined
}

async function readActiveWindow(): Promise<NativeWindow | undefined> {
  // get-windows talks X11 only, so ask the compositor first when we are on one
  // it knows. Falling through would cost an activeWindow() call per capture
  // that can only ever return undefined.
  const wayland = await readWaylandWindow()
  if (wayland) {
    return { title: wayland.title, owner: { name: wayland.app, processId: wayland.pid } }
  }

  if (packageActiveWindowWorks) {
    try {
      const window = (await activeWindow()) as NativeWindow | undefined
      if (window) return window
    } catch {
      packageActiveWindowWorks = false
    }
  }

  const addon = loadBundledWindowsAddon()
  if (!addon) return undefined
  return addon.getActiveWindow()
}

export async function snapshotWindow(): Promise<WindowContext | undefined> {
  const w = await readActiveWindow()
  if (!w?.owner?.name || !w.title) return undefined

  const ctx: WindowContext = {
    app: w.owner.name,
    title: w.title,
    pid: w.owner.processId,
  }
  if (typeof w.url === 'string' && w.url.length > 0) {
    ctx.url = w.url
  }
  return ctx
}
