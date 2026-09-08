import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CRATES = ['tray', 'asr', 'util'] as const

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

function writeIfChanged(path: string, next: string, check: boolean): boolean {
  const current = readText(path)
  if (current === next) return false
  if (check) {
    console.error(`${path} is out of sync with package.json version`)
    return true
  }
  writeFileSync(path, next)
  return true
}

function updatePackageVersionToml(input: string, version: string): string {
  return input.replace(/(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${version}"`)
}

function packageVersion(): string {
  const pkg = JSON.parse(readText(join(ROOT, 'package.json'))) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json version is missing')
  }
  return pkg.version
}

function refreshCargoLock(): void {
  const result = spawnSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  if (result.status !== 0) {
    throw new Error('failed to refresh Cargo.lock via cargo metadata')
  }
}

const check = process.argv.includes('--check')
const version = packageVersion()
let changed = false

changed =
  writeIfChanged(join(ROOT, 'src', 'version.ts'), `export const VERSION = '${version}'\n`, check) ||
  changed

for (const crate of CRATES) {
  const path = join(ROOT, crate, 'Cargo.toml')
  changed =
    writeIfChanged(path, updatePackageVersionToml(readText(path), version), check) || changed
}

if (check) {
  if (changed) process.exit(1)
} else {
  refreshCargoLock()
  console.log(`synced Hyprmnesia version ${version}`)
}
