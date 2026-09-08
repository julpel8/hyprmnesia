import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Shared launcher integration: desktop-launcher discovery (GNOME/KDE) and
 * opt-in login autostart.
 *
 * The file *contents* (`.desktop`) are generated here so that there is a
 * single source of truth used by both the system installer
 * (`scripts/package.ts`, which writes into the `.deb` payload) and the
 * user-facing CLI (`hpm launcher …` / `hpm autostart …`, which writes into
 * the per-user XDG locations and doubles as the portable / post-install
 * repair path).
 */

const DESKTOP_FILE = 'hyprmnesia.desktop'
const ICON_SIZES = [128, 256, 512] as const

// ---------------------------------------------------------------------------
// Content generators (pure — no filesystem side effects)
// ---------------------------------------------------------------------------

/**
 * Renders a freedesktop `.desktop` entry. `exec` is the full command line
 * (e.g. `/usr/bin/hpm start`) and `tryExec` is the bare binary path used by
 * desktop environments to decide whether to show the entry. When `autostart`
 * is set, the GNOME autostart-enabled key is appended for the login-autostart
 * copy under `~/.config/autostart`.
 */
export function desktopEntry(opts: { exec: string; tryExec: string; autostart: boolean }): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Hyprmnesia',
    'GenericName=Screen & Audio Memory',
    'Comment=Local-first screen and audio memory for desktop assistants',
    `Exec=${opts.exec}`,
    `TryExec=${opts.tryExec}`,
    'Icon=hyprmnesia',
    'Terminal=false',
    'Categories=Utility;AudioVideo;Recorder;',
    'Keywords=memory;capture;screenshot;audio;recall;assistant;',
    'StartupNotify=false',
    'X-GNOME-UsesNotifications=true',
  ]
  if (opts.autostart) lines.push('X-GNOME-Autostart-enabled=true')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Path + resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the `hpm` binary the launcher should invoke. Prefers the stable
 * system install location when present (so a GUI launcher that does not inherit
 * the shell `PATH` still works), otherwise falls back to the running binary —
 * the portable case, where the `.tar.gz` may live anywhere.
 */
function resolveExec(): string {
  if (existsSync('/usr/bin/hpm')) return '/usr/bin/hpm'
  return process.execPath
}

function xdgDataHome(): string {
  const env = process.env.XDG_DATA_HOME
  return env && env.trim() !== '' ? env : join(homedir(), '.local', 'share')
}

function xdgConfigHome(): string {
  const env = process.env.XDG_CONFIG_HOME
  return env && env.trim() !== '' ? env : join(homedir(), '.config')
}

function desktopFilePath(): string {
  return join(xdgDataHome(), 'applications', DESKTOP_FILE)
}

function autostartFilePath(): string {
  return join(xdgConfigHome(), 'autostart', DESKTOP_FILE)
}

function iconInstallPath(size: number): string {
  return join(xdgDataHome(), 'icons', 'hicolor', `${size}x${size}`, 'apps', 'hyprmnesia.png')
}

/**
 * Finds the bundled brand assets directory across packaged, portable, and
 * development layouts (mirrors how `findTrayBinary` resolves native helpers).
 */
function brandAssetsDir(): string | undefined {
  const candidates = [
    join(dirname(process.execPath), 'assets', 'brand'),
    join(process.cwd(), 'assets', 'brand'),
    join(process.cwd(), 'dist', 'assets', 'brand'),
    join(import.meta.dir, '..', '..', 'assets', 'brand'),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'hyprmnesia-mark-512.png')))
}

function brandIconPng(dir: string, size: number): string {
  return join(dir, `hyprmnesia-mark-${size}.png`)
}

// ---------------------------------------------------------------------------
// User-facing install / uninstall / autostart
// ---------------------------------------------------------------------------

/** Installs a per-user launcher entry (portable / post-install repair). */
export function installLauncher(): void {
  const exec = resolveExec()
  const desktop = desktopFilePath()
  mkdirSync(join(xdgDataHome(), 'applications'), { recursive: true })
  writeFileSync(desktop, desktopEntry({ exec: `${exec} start`, tryExec: exec, autostart: false }))
  const brand = brandAssetsDir()
  if (brand) {
    for (const size of ICON_SIZES) {
      const src = brandIconPng(brand, size)
      if (!existsSync(src)) continue
      const dest = iconInstallPath(size)
      mkdirSync(join(dest, '..'), { recursive: true })
      copyFileSync(src, dest)
    }
  } else {
    console.log('warning: brand icons not found; the launcher entry will use a generic icon.')
  }
  console.log(`installed launcher entry: ${desktop}`)
  console.log(`  Exec=${exec} start`)
}

/** Removes the per-user launcher entry created by `installLauncher`. */
export function uninstallLauncher(): void {
  rmSync(desktopFilePath(), { force: true })
  for (const size of ICON_SIZES) rmSync(iconInstallPath(size), { force: true })
  console.log('removed launcher entry and icons.')
}

/** Enables login autostart (opt-in). */
export function enableAutostart(): void {
  const exec = resolveExec()
  const file = autostartFilePath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, desktopEntry({ exec: `${exec} start`, tryExec: exec, autostart: true }))
  console.log(`autostart enabled: ${file}`)
}

/** Disables login autostart. */
export function disableAutostart(): void {
  rmSync(autostartFilePath(), { force: true })
  console.log('autostart disabled.')
}

/** Reports the current login-autostart state. */
export function autostartStatus(): void {
  const file = autostartFilePath()
  console.log(`autostart: ${existsSync(file) ? `enabled (${file})` : 'disabled'}`)
}
