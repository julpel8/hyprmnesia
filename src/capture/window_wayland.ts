// Active-window metadata on Wayland. `get-windows` only speaks X11, so under a
// wlroots compositor it returns undefined and every chunk lands with a null
// app/title. Sway and Hyprland both ship a CLI that answers the same question
// over their own IPC socket, so we shell out to it.
//
// Neither compositor exposes the focused browser tab's URL: the Wayland
// protocol carries a title and an app id, nothing more. `url` stays undefined
// here.

export interface WaylandWindow {
  app: string
  title: string
  pid?: number
}

interface SwayNode {
  focused?: boolean
  pid?: number
  name?: string
  app_id?: string
  window_properties?: { class?: string }
  nodes?: SwayNode[]
  floating_nodes?: SwayNode[]
}

interface HyprWindow {
  class?: string
  initialClass?: string
  title?: string
  pid?: number
}

async function runJson(cmd: string[]): Promise<unknown> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0 || !text.trim()) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function findFocused(node: SwayNode): SwayNode | undefined {
  if (node.focused && typeof node.pid === 'number') return node
  for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
    const found = findFocused(child)
    if (found) return found
  }
  return undefined
}

async function readSway(): Promise<WaylandWindow | undefined> {
  const tree = (await runJson(['swaymsg', '-t', 'get_tree', '-r'])) as SwayNode | undefined
  if (!tree) return undefined
  const win = findFocused(tree)
  const app = win?.app_id ?? win?.window_properties?.class
  if (!win || !app || !win.name) return undefined
  return { app, title: win.name, pid: win.pid }
}

async function readHyprland(): Promise<WaylandWindow | undefined> {
  const win = (await runJson(['hyprctl', '-j', 'activewindow'])) as HyprWindow | undefined
  const app = win?.class ?? win?.initialClass
  if (!win || !app || !win.title) return undefined
  return { app, title: win.title, pid: win.pid }
}

// Undefined on anything that is not a wlroots compositor we know how to ask, or
// when nothing is focused (an empty workspace, a lock screen).
export async function readWaylandWindow(): Promise<WaylandWindow | undefined> {
  if (process.platform !== 'linux') return undefined
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return readHyprland()
  if (process.env.SWAYSOCK) return readSway()
  return undefined
}
