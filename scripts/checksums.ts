import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const ARTIFACTS = join(ROOT, 'artifacts')

if (!existsSync(ARTIFACTS)) throw new Error('artifacts directory does not exist')

const files = readdirSync(ARTIFACTS)
  .filter((name) => name !== 'SHA256SUMS' && name !== 'RELEASE_NOTES.md')
  .filter((name) => statSync(join(ARTIFACTS, name)).isFile())
  .sort()

const lines = files.map((name) => {
  const hash = createHash('sha256')
    .update(readFileSync(join(ARTIFACTS, name)))
    .digest('hex')
  return `${hash}  ${name}`
})

writeFileSync(join(ARTIFACTS, 'SHA256SUMS'), `${lines.join('\n')}\n`)
console.log(`wrote SHA256SUMS for ${files.length} artifacts`)
