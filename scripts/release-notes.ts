import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const versionArg = process.argv[2]?.replace(/^v/, '')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
const version = versionArg || pkg.version

if (!version) throw new Error('release-notes requires a version')

const tag = `v${version}`

function git(...args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

function commitRange(): string {
  const ref = git('rev-parse', '--verify', `${tag}^{commit}`) ? tag : 'HEAD'
  const previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${ref}^`)
  return previous ? `${previous}..${ref}` : ref
}

const log = git('log', '--no-merges', '--pretty=%s', commitRange()) ?? ''
const entries = log
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !/^chore: release v/.test(line))

const notes = [
  `## Hyprmnesia ${tag}`,
  '',
  ...(entries.length > 0 ? entries.map((entry) => `- ${entry}`) : ['No recorded changes.']),
].join('\n')

mkdirSync(join(ROOT, 'artifacts'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'RELEASE_NOTES.md'), `${notes}\n`)
console.log(`wrote release notes for ${tag}`)
