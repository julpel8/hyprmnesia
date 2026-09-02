import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { windowsInstallerSource } from './package'

const dirs: string[] = []

function freshAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-package-'))
  dirs.push(dir)
  return dir
}

function writeAppFile(appDir: string, relPath: string): void {
  const file = join(appDir, relPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, relPath)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('windowsInstallerSource declares parent directories for nested files', () => {
  const appDir = freshAppDir()
  writeAppFile(appDir, 'hpm.exe')
  writeAppFile(appDir, join('assets', 'brand', 'hyprmnesia-mark-128.png'))
  writeAppFile(appDir, join('native', 'onnxruntime', 'lib', 'onnxruntime.dll'))

  const wxs = windowsInstallerSource(appDir, '1.2.3')
  const declaredDirs = new Set(
    [...wxs.matchAll(/<(?:Standard)?Directory Id="([^"]+)"/g)].map((match) => match[1]),
  )
  const componentDirs = [...wxs.matchAll(/<Component Id="[^"]+" Directory="([^"]+)"/g)].map(
    (match) => match[1],
  )

  for (const dir of componentDirs) expect(declaredDirs.has(dir)).toBe(true)
  expect(wxs).toContain('Name="assets"')
  expect(wxs).toContain('Name="brand"')
  expect(wxs).toContain('Name="native"')
  expect(wxs).toContain('Name="onnxruntime"')
  expect(wxs).toContain('Name="lib"')
})
