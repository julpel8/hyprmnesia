import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { desktopEntry } from '../src/install/launcher'

const ROOT = join(import.meta.dir, '..')
const BRAND = join(ROOT, 'assets', 'brand')
const ICON_SIZES = [128, 256, 512] as const
const DIST = join(ROOT, 'dist')
const ARTIFACTS = join(ROOT, 'artifacts')
const STAGING = join(ARTIFACTS, 'staging')

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json version is missing')
  }
  return pkg.version
}

function archName(): string {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function debArch(): string {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  throw new Error(`unsupported deb architecture: ${process.arch}`)
}

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

function ensureDist(): void {
  if (!existsSync(join(DIST, 'hpm'))) {
    throw new Error('missing dist/hpm; run bun run build before packaging')
  }
  if (!existsSync(join(DIST, 'native'))) {
    throw new Error('missing dist/native; run bun run build before packaging')
  }
}

function copyRuntime(dest: string): void {
  mkdirSync(dest, { recursive: true })
  copyFileSync(join(DIST, 'hpm'), join(dest, 'hpm'))
  cpSync(join(DIST, 'native'), join(dest, 'native'), { recursive: true })
  for (const doc of ['README.md', 'LICENSE']) {
    const src = join(ROOT, doc)
    if (existsSync(src)) copyFileSync(src, join(dest, doc))
  }
  copyBrandAssets(join(dest, 'assets', 'brand'))
  for (const file of listFiles(dest)) chmodSync(join(dest, file), 0o755)
}

/**
 * Copies the brand icons next to the binary so `hpm launcher install` can
 * find them in the portable/extracted layout.
 */
function copyBrandAssets(dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const size of ICON_SIZES) {
    const src = join(BRAND, `hyprmnesia-mark-${size}.png`)
    if (existsSync(src)) copyFileSync(src, join(dest, `hyprmnesia-mark-${size}.png`))
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const child of listFiles(path)) out.push(join(entry.name, child))
    } else if (entry.isFile()) {
      out.push(entry.name)
    }
  }
  return out.sort()
}

function makePortable(appDir: string, version: string, target: string): string {
  const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.tar.gz`)
  run('tar', ['-czf', out, '-C', dirname(appDir), basename(appDir)])
  return out
}

function makeDeb(version: string, target: string): string {
  const root = join(STAGING, 'deb-root')
  const app = join(root, 'opt', 'hyprmnesia')
  const debian = join(root, 'DEBIAN')
  const bin = join(root, 'usr', 'bin')
  rmSync(root, { recursive: true, force: true })
  copyRuntime(app)
  mkdirSync(debian, { recursive: true })
  mkdirSync(bin, { recursive: true })
  symlinkSync('/opt/hyprmnesia/hpm', join(bin, 'hpm'))
  writeFileSync(
    join(debian, 'control'),
    `Package: hyprmnesia
Version: ${version.replaceAll('-', '~')}
Section: utils
Priority: optional
Architecture: ${debArch()}
Maintainer: Hyprmnesia <maintainers@hyprmnesia.local>
Depends: ffmpeg, imagemagick, tesseract-ocr, libgtk-3-0, libxdo3, libayatana-appindicator3-1, gstreamer1.0-plugins-base, gstreamer1.0-pipewire, pipewire
Description: Local-first screen and audio memory for desktop assistants
 Hyprmnesia records local screenshots, audio, and window context and exposes
 read-only search and replay surfaces.
`,
  )

  // Desktop-launcher entry so Hyprmnesia is discoverable in GNOME/KDE.
  const applications = join(root, 'usr', 'share', 'applications')
  mkdirSync(applications, { recursive: true })
  writeFileSync(
    join(applications, 'hyprmnesia.desktop'),
    desktopEntry({ exec: '/usr/bin/hpm start', tryExec: '/usr/bin/hpm', autostart: false }),
  )

  // hicolor theme icons (Icon=hyprmnesia resolves against these).
  for (const size of ICON_SIZES) {
    const src = join(BRAND, `hyprmnesia-mark-${size}.png`)
    if (!existsSync(src)) continue
    const iconDir = join(root, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps')
    mkdirSync(iconDir, { recursive: true })
    copyFileSync(src, join(iconDir, 'hyprmnesia.png'))
  }

  // Best-effort cache refresh so the entry and icon appear promptly. Both tools
  // are optional, hence the `command -v` guards and `|| true`.
  const maintainerScript = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
`
  for (const name of ['postinst', 'postrm']) {
    const script = join(debian, name)
    writeFileSync(script, maintainerScript)
    chmodSync(script, 0o755)
  }

  const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.deb`)
  run('dpkg-deb', ['--build', '--root-owner-group', root, out])
  return out
}

if (import.meta.main) {
  ensureDist()

  const version = packageVersion()
  const target = `linux-${archName()}`
  const portableOnly = process.argv.includes('--portable-only')
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })

  const portableDir = join(STAGING, `hyprmnesia-${version}-${target}`)
  copyRuntime(portableDir)
  const outputs = [makePortable(portableDir, version, target)]

  if (!portableOnly) outputs.push(makeDeb(version, target))

  console.log('packaged artifacts:')
  for (const output of outputs) console.log(`- ${relative(ROOT, output).split(sep).join('/')}`)
}
