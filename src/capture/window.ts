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

let packageActiveWindowWorks = true

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

  return undefined
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
