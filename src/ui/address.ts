import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { apiAddressPath } from '../util/paths'

// Where `hpm api` is listening, for callers that were not told the port. The
// file is the whole discovery mechanism: there is no registry and no fixed port
// guarantee, so a client reads this or passes --port itself.

export interface ApiAddress {
  url: string
  port: number
  pid: number
  started_at: number
}

export function writeApiAddress(port: number): void {
  const path = apiAddressPath()
  mkdirSync(dirname(path), { recursive: true })
  const address: ApiAddress = {
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    started_at: Date.now(),
  }
  writeFileSync(path, `${JSON.stringify(address, null, 2)}\n`)
}

export function clearApiAddress(): void {
  rmSync(apiAddressPath(), { force: true })
}

// Returns the published address, or undefined when no server is serving. A
// stale file left by a killed process is treated as absent rather than
// reported, so a caller never dials a dead port.
export function readApiAddress(): ApiAddress | undefined {
  const path = apiAddressPath()
  if (!existsSync(path)) return undefined
  let address: ApiAddress
  try {
    address = JSON.parse(readFileSync(path, 'utf8')) as ApiAddress
  } catch {
    return undefined
  }
  if (typeof address.port !== 'number' || typeof address.pid !== 'number') return undefined
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(address.pid, 0)
  } catch {
    return undefined
  }
  return address
}
