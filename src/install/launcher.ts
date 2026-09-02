import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VERSION } from '../version'

/**
 * Shared launcher integration: desktop-launcher discovery (GNOME/KDE,
 * Spotlight/Finder/Launchpad) and opt-in login autostart.
 *
 * The file *contents* (`.desktop`, macOS `Info.plist`, LaunchAgent plist) are
 * generated here so that there is a single source of truth used by both the
 * system installers (`scripts/package.ts`, which write into `.deb`/`.pkg`
 * payloads) and the user-facing CLI (`hpm launcher …` / `hpm autostart …`,
 * which write into the per-user XDG / `~/Library` locations and double as the
 * portable / post-install repair path).
 */

/** Reverse-DNS identifier, also used as the LaunchAgent label on macOS. */
const BUNDLE_ID = 'org.hyprmnesia.hyprmnesia'
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
    'Keywords=memory;capture;screenshot;audio;recall;mcp;assistant;',
    'StartupNotify=false',
    'X-GNOME-UsesNotifications=true',
  ]
  if (opts.autostart) lines.push('X-GNOME-Autostart-enabled=true')
  return `${lines.join('\n')}\n`
}

/**
 * Renders the `Info.plist` for the thin `Hyprmnesia.app` wrapper bundle.
 * `LSUIElement` keeps it out of the Dock (it behaves like a tray agent) while
 * remaining visible in Spotlight / Finder / Launchpad.
 */
export function macAppInfoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Hyprmnesia</string>
    <key>CFBundleDisplayName</key>
    <string>Hyprmnesia</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>Hyprmnesia</string>
    <key>CFBundleIconFile</key>
    <string>hyprmnesia.icns</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`
}

/**
 * Renders the launchd LaunchAgent plist for login autostart. `programPath` is
 * the absolute `hpm` path; `launchd` does not expand `~`, so log paths are
 * absolute and only capture launchd bootstrap output (the real app log stays
 * under `~/.hyprmnesia/`). `KeepAlive=false` so a deliberate `hpm stop`/`quit`
 * is respected.
 */
export function launchAgentPlist(opts: { programPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${BUNDLE_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${opts.programPath}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/tmp/hyprmnesia.launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/hyprmnesia.launchd.err.log</string>
</dict>
</plist>
`
}

/** Renders the macOS app-bundle launcher shim (`Contents/MacOS/Hyprmnesia`). */
export function macLauncherScript(programPath: string): string {
  return `#!/bin/sh\nexec ${programPath} start\n`
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
  const systemPaths =
    process.platform === 'darwin'
      ? ['/usr/local/bin/hpm']
      : process.platform === 'linux'
        ? ['/usr/bin/hpm']
        : []
  for (const p of systemPaths) if (existsSync(p)) return p
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

function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${BUNDLE_ID}.plist`)
}

function macAppPath(): string {
  return join(homedir(), 'Applications', 'Hyprmnesia.app')
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

/**
 * Best-effort `.icns` generation from the 512px brand mark using the macOS
 * `sips`/`iconutil` toolchain. Returns false (without throwing) when the tools
 * are unavailable, so callers can fall back to an icon-less bundle.
 */
export function generateIcns(srcPng: string, outIcns: string): boolean {
  if (process.platform !== 'darwin' || !existsSync(srcPng)) return false
  const iconset = mkdtempSync(join(tmpdir(), 'hyprmnesia-iconset-'))
  const sizes: Array<[number, string]> = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
  ]
  try {
    for (const [px, name] of sizes) {
      const r = spawnSync(
        'sips',
        ['-z', String(px), String(px), srcPng, '--out', join(iconset, name)],
        { stdio: 'ignore' },
      )
      if (r.status !== 0) return false
    }
    const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', outIcns], { stdio: 'ignore' })
    return r.status === 0
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

/**
 * Writes the `Hyprmnesia.app` wrapper bundle at `appDir`, executing `exec`.
 * Shared by the `.pkg` builder and the portable `hpm launcher install` path.
 */
function writeMacAppBundle(appDir: string, exec: string, version: string): void {
  const contents = join(appDir, 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(contents, 'Info.plist'), macAppInfoPlist(version))
  const launcher = join(macos, 'Hyprmnesia')
  writeFileSync(launcher, macLauncherScript(exec))
  chmodSync(launcher, 0o755)

  const icns = join(resources, 'hyprmnesia.icns')
  const brand = brandAssetsDir()
  const prebuilt = brand ? join(brand, 'hyprmnesia.icns') : undefined
  if (prebuilt && existsSync(prebuilt)) copyFileSync(prebuilt, icns)
  else if (brand) generateIcns(brandIconPng(brand, 512), icns)
}

// ---------------------------------------------------------------------------
// User-facing install / uninstall / autostart
// ---------------------------------------------------------------------------

function notSupported(feature: string): void {
  console.log(
    `${feature} is not available on ${process.platform}. ` +
      'On Windows the MSI already registers a Start Menu shortcut.',
  )
}

/** Installs a per-user launcher entry (portable / post-install repair). */
export function installLauncher(): void {
  const exec = resolveExec()
  if (process.platform === 'linux') {
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
    return
  }
  if (process.platform === 'darwin') {
    const app = macAppPath()
    rmSync(app, { recursive: true, force: true })
    writeMacAppBundle(app, exec, VERSION)
    console.log(`installed app bundle: ${app}`)
    console.log(`  exec ${exec} start`)
    return
  }
  notSupported('hpm launcher')
}

/** Removes the per-user launcher entry created by `installLauncher`. */
export function uninstallLauncher(): void {
  if (process.platform === 'linux') {
    rmSync(desktopFilePath(), { force: true })
    for (const size of ICON_SIZES) rmSync(iconInstallPath(size), { force: true })
    console.log('removed launcher entry and icons.')
    return
  }
  if (process.platform === 'darwin') {
    rmSync(macAppPath(), { recursive: true, force: true })
    console.log(`removed app bundle: ${macAppPath()}`)
    return
  }
  notSupported('hpm launcher')
}

function uid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '0'
}

/** Enables login autostart (opt-in). */
export function enableAutostart(): void {
  const exec = resolveExec()
  if (process.platform === 'linux') {
    const file = autostartFilePath()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, desktopEntry({ exec: `${exec} start`, tryExec: exec, autostart: true }))
    console.log(`autostart enabled: ${file}`)
    return
  }
  if (process.platform === 'darwin') {
    const plist = launchAgentPath()
    mkdirSync(join(plist, '..'), { recursive: true })
    writeFileSync(plist, launchAgentPlist({ programPath: exec }))
    const target = `gui/${uid()}`
    const boot = spawnSync('launchctl', ['bootstrap', target, plist], { stdio: 'ignore' })
    if (boot.status !== 0) {
      // Older macOS without `bootstrap`: fall back to the legacy loader.
      spawnSync('launchctl', ['load', '-w', plist], { stdio: 'ignore' })
    }
    console.log(`autostart enabled: ${plist}`)
    return
  }
  notSupported('hpm autostart')
}

/** Disables login autostart. */
export function disableAutostart(): void {
  if (process.platform === 'linux') {
    rmSync(autostartFilePath(), { force: true })
    console.log('autostart disabled.')
    return
  }
  if (process.platform === 'darwin') {
    const plist = launchAgentPath()
    const target = `gui/${uid()}/${BUNDLE_ID}`
    const out = spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' })
    if (out.status !== 0 && existsSync(plist)) {
      spawnSync('launchctl', ['unload', '-w', plist], { stdio: 'ignore' })
    }
    rmSync(plist, { force: true })
    console.log('autostart disabled.')
    return
  }
  notSupported('hpm autostart')
}

/** Reports the current login-autostart state. */
export function autostartStatus(): void {
  if (process.platform === 'linux') {
    const file = autostartFilePath()
    console.log(`autostart: ${existsSync(file) ? `enabled (${file})` : 'disabled'}`)
    return
  }
  if (process.platform === 'darwin') {
    const plist = launchAgentPath()
    const loaded =
      spawnSync('launchctl', ['print', `gui/${uid()}/${BUNDLE_ID}`], { stdio: 'ignore' }).status ===
      0
    console.log(
      `autostart: ${loaded ? 'enabled (loaded)' : existsSync(plist) ? 'installed (not loaded)' : 'disabled'}`,
    )
    return
  }
  notSupported('hpm autostart')
}
