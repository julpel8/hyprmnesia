import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  desktopEntry,
  generateIcns,
  launchAgentPlist,
  macAppInfoPlist,
  macLauncherScript,
} from '../src/install/launcher'

const ROOT = join(import.meta.dir, '..')
const BRAND = join(ROOT, 'assets', 'brand')
const ICON_SIZES = [128, 256, 512] as const
const DIST = join(ROOT, 'dist')
const ARTIFACTS = join(ROOT, 'artifacts')
const STAGING = join(ARTIFACTS, 'staging')
const APP_ICON = join(ROOT, 'assets', 'brand', 'hyprmnesia.ico')
const UPGRADE_CODE = '{8F994E2E-33FB-4B7F-AE2B-B98F75C4815D}'

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json version is missing')
  }
  return pkg.version
}

function platformName(): 'windows' | 'macos' | 'linux' {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`unsupported release platform: ${process.platform}`)
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
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !command.endsWith('.exe'),
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

function ensureDist(): void {
  const exe = process.platform === 'win32' ? 'hpm.exe' : 'hpm'
  if (!existsSync(join(DIST, exe))) {
    throw new Error(`missing dist/${exe}; run bun run build before packaging`)
  }
  if (!existsSync(join(DIST, 'native'))) {
    throw new Error('missing dist/native; run bun run build before packaging')
  }
  if (process.platform === 'win32' && !existsSync(APP_ICON)) {
    throw new Error(`missing app icon: ${APP_ICON}`)
  }
}

function copyRuntime(dest: string): void {
  mkdirSync(dest, { recursive: true })
  const exe = process.platform === 'win32' ? 'hpm.exe' : 'hpm'
  copyFileSync(join(DIST, exe), join(dest, exe))
  cpSync(join(DIST, 'native'), join(dest, 'native'), { recursive: true })
  for (const doc of ['README.md', 'LICENSE']) {
    const src = join(ROOT, doc)
    if (existsSync(src)) copyFileSync(src, join(dest, doc))
  }
  copyBrandAssets(join(dest, 'assets', 'brand'))
  if (process.platform !== 'win32') {
    for (const file of listFiles(dest)) chmodSync(join(dest, file), 0o755)
  }
}

/**
 * Copies the brand icons next to the binary so `hpm launcher install` can find
 * them in the portable/extracted layout. On macOS a `.icns` is generated (or
 * reused if pre-committed) for the app-bundle icon.
 */
function copyBrandAssets(dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const size of ICON_SIZES) {
    const src = join(BRAND, `hyprmnesia-mark-${size}.png`)
    if (existsSync(src)) copyFileSync(src, join(dest, `hyprmnesia-mark-${size}.png`))
  }
  if (process.platform === 'darwin') {
    const icns = join(dest, 'hyprmnesia.icns')
    const prebuilt = join(BRAND, 'hyprmnesia.icns')
    if (existsSync(prebuilt)) copyFileSync(prebuilt, icns)
    else generateIcns(join(BRAND, 'hyprmnesia-mark-512.png'), icns)
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
  if (process.platform === 'win32') {
    const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.zip`)
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -LiteralPath ${psQuote(appDir)} -DestinationPath ${psQuote(out)} -Force`,
    ])
    return out
  }

  const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.tar.gz`)
  run('tar', ['-czf', out, '-C', dirname(appDir), basename(appDir)])
  return out
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function id(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 24)}`
}

function msiVersion(version: string): string {
  const core = version.split(/[+-]/)[0] ?? version
  const parts = core.split('.').map((part) => Number(part))
  while (parts.length < 3) parts.push(0)
  return parts
    .slice(0, 3)
    .map((part) => (Number.isInteger(part) && part >= 0 ? part : 0))
    .join('.')
}

function dirId(relDir: string): string {
  return relDir === '' ? 'INSTALLFOLDER' : id('dir', relDir)
}

function addDirectoryAncestors(dirs: Set<string>, relDir: string): void {
  let dir = relDir
  while (dir !== '' && dir !== '.') {
    dirs.add(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

function directoryXml(parent: string, allDirs: Set<string>, indent: string): string {
  const children = [...allDirs]
    .filter((dir) => dirname(dir) === (parent === '' ? '.' : parent))
    .sort()
  return children
    .map((dir) => {
      const name = basename(dir)
      const nested = directoryXml(dir, allDirs, `${indent}  `)
      return `${indent}<Directory Id="${dirId(dir)}" Name="${xml(name)}">${nested ? `\n${nested}\n${indent}` : ''}</Directory>`
    })
    .join('\n')
}

export function windowsInstallerSource(appDir: string, version: string): string {
  const files = listFiles(appDir)
  const dirs = new Set<string>()
  for (const file of files) {
    const dir = dirname(file)
    addDirectoryAncestors(dirs, dir)
  }
  const directoryTree = directoryXml('', dirs, '          ')
  const components = files
    .map((file) => {
      const relDir = dirname(file) === '.' ? '' : dirname(file)
      const source = resolve(appDir, file)
      return `      <Component Id="${id('cmp', file)}" Directory="${dirId(relDir)}" Guid="*">
        <File Id="${id('file', file)}" Source="${xml(source)}" KeyPath="yes" />
      </Component>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Hyprmnesia" Manufacturer="Hyprmnesia" Version="${msiVersion(version)}" UpgradeCode="${UPGRADE_CODE}" Scope="perUser">
    <MajorUpgrade DowngradeErrorMessage="A newer Hyprmnesia version is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Feature Id="MainFeature" Title="Hyprmnesia" Level="1">
      <ComponentGroupRef Id="AppFiles" />
      <ComponentRef Id="StartMenuShortcut" />
      <ComponentRef Id="PathEnvironment" />
    </Feature>
  </Package>

  <Fragment>
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsDir" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="Hyprmnesia">${directoryTree ? `\n${directoryTree}\n        ` : ''}</Directory>
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ApplicationProgramsFolder" Name="Hyprmnesia" />
    </StandardDirectory>
  </Fragment>

  <Fragment>
    <ComponentGroup Id="AppFiles">
${components}
    </ComponentGroup>
    <Component Id="StartMenuShortcut" Directory="ApplicationProgramsFolder" Guid="*">
      <Shortcut Id="HyprmnesiaShortcut" Name="Hyprmnesia" Target="[INSTALLFOLDER]hpm.exe" WorkingDirectory="INSTALLFOLDER" Icon="HyprmnesiaIcon" />
      <RemoveFolder Id="ApplicationProgramsFolder" On="uninstall" />
      <RegistryValue Root="HKCU" Key="Software\\Hyprmnesia" Name="startMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
    </Component>
    <Icon Id="HyprmnesiaIcon" SourceFile="${xml(APP_ICON)}" />
    <Component Id="PathEnvironment" Directory="INSTALLFOLDER" Guid="*">
      <Environment Id="UserPath" Name="PATH" Value="[INSTALLFOLDER]" Permanent="no" Part="last" Action="set" System="no" />
      <RegistryValue Root="HKCU" Key="Software\\Hyprmnesia" Name="pathEnvironment" Type="integer" Value="1" KeyPath="yes" />
    </Component>
  </Fragment>
</Wix>
`
}

function makeWindowsMsi(appDir: string, version: string, target: string): string {
  const wxs = join(STAGING, 'hyprmnesia.wxs')
  const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.msi`)
  writeFileSync(wxs, windowsInstallerSource(appDir, version))
  run('wix', ['build', '-arch', 'x64', '-out', out, wxs])
  return out
}

function makeMacPkg(version: string, target: string): string {
  const root = join(STAGING, 'pkg-root')
  const app = join(root, 'usr', 'local', 'hyprmnesia')
  const bin = join(root, 'usr', 'local', 'bin')
  rmSync(root, { recursive: true, force: true })
  copyRuntime(app)
  mkdirSync(bin, { recursive: true })
  symlinkSync('../hyprmnesia/hpm', join(bin, 'hpm'))

  // Thin app-bundle wrapper so Hyprmnesia shows up in Spotlight/Finder/Launchpad
  // and launches the CLI installed under /usr/local.
  const appBundle = join(root, 'Applications', 'Hyprmnesia.app', 'Contents')
  const appMacOS = join(appBundle, 'MacOS')
  const appResources = join(appBundle, 'Resources')
  mkdirSync(appMacOS, { recursive: true })
  mkdirSync(appResources, { recursive: true })
  writeFileSync(join(appBundle, 'Info.plist'), macAppInfoPlist(version))
  const launcher = join(appMacOS, 'Hyprmnesia')
  writeFileSync(launcher, macLauncherScript('/usr/local/bin/hpm'))
  chmodSync(launcher, 0o755)
  const icns = join(appResources, 'hyprmnesia.icns')
  const prebuiltIcns = join(BRAND, 'hyprmnesia.icns')
  if (existsSync(prebuiltIcns)) copyFileSync(prebuiltIcns, icns)
  else generateIcns(join(BRAND, 'hyprmnesia-mark-512.png'), icns)

  // LaunchAgent template for opt-in login autostart. The .pkg runs as root and
  // must not write into ~/Library; `hpm autostart enable` copies this into the
  // user's LaunchAgents directory.
  const launchdDir = join(app, 'launchd')
  mkdirSync(launchdDir, { recursive: true })
  writeFileSync(
    join(launchdDir, 'org.hyprmnesia.hyprmnesia.plist'),
    launchAgentPlist({ programPath: '/usr/local/bin/hpm' }),
  )

  const out = join(ARTIFACTS, `hyprmnesia-${version}-${target}.pkg`)
  run('pkgbuild', [
    '--root',
    root,
    '--identifier',
    'org.hyprmnesia.hyprmnesia',
    '--version',
    version,
    '--install-location',
    '/',
    out,
  ])
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
  const target = `${platformName()}-${archName()}`
  const portableOnly = process.argv.includes('--portable-only')
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })

  const portableDir = join(STAGING, `hyprmnesia-${version}-${target}`)
  copyRuntime(portableDir)
  const outputs = [makePortable(portableDir, version, target)]

  if (!portableOnly) {
    if (process.platform === 'win32') outputs.push(makeWindowsMsi(portableDir, version, target))
    else if (process.platform === 'darwin') outputs.push(makeMacPkg(version, target))
    else if (process.platform === 'linux') outputs.push(makeDeb(version, target))
  }

  console.log('packaged artifacts:')
  for (const output of outputs) console.log(`- ${relative(ROOT, output).split(sep).join('/')}`)
}
