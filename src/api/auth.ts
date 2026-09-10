import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const TOKEN_PREFIX = 'hpm_api_'
const VERIFIER_PREFIX = 'sha256:'
const SERVICE_NAME = 'hyprmnesia-api-token'
const SECRET_ATTRIBUTES = ['service', 'hyprmnesia', 'name', 'api-token']

// Verifiers we persist are `sha256:<hex>` — never anything needing shell-style
// quoting. The guard keeps a value from breaking out of the single-line
// `security -i` subcommand it is embedded in.
const SECRET_VALUE_CHARSET = /^[A-Za-z0-9_.:/+=-]+$/

// Builds the line piped to `security -i` on stdin. Running the subcommand
// through interactive mode keeps the secret out of argv (invisible to `ps`),
// unlike passing `-w <value>` on the command line. Exported for unit testing.
export function buildMacKeychainAddInput(service: string, account: string, value: string): string {
  if (!SECRET_VALUE_CHARSET.test(value)) {
    throw new Error('secret value contains characters unsafe for keychain interactive mode')
  }
  return `add-generic-password -U -s ${macQuote(service)} -a ${macQuote(account)} -w ${value}\n`
}

function macQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export interface ApiAuthStore {
  readonly name: string
  read(): string | undefined
  write(verifier: string): void
  delete?(): void
}

export interface ApiAuthStatus {
  enabled: boolean
  configured: boolean
  backend: string
}

export type ApiAuthFailure = 'missing_token' | 'unconfigured' | 'invalid_token'

export class MemoryApiAuthStore implements ApiAuthStore {
  readonly name = 'memory'
  private verifier: string | undefined

  read(): string | undefined {
    return this.verifier
  }

  write(verifier: string): void {
    this.verifier = verifier
  }
}

class FileApiAuthStore implements ApiAuthStore {
  readonly name = 'file'

  constructor(private readonly path = defaultVerifierPath()) {}

  read(): string | undefined {
    if (!existsSync(this.path)) return undefined
    const raw = readFileSync(this.path, 'utf8').trim()
    return raw === '' ? undefined : raw
  }

  write(verifier: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${verifier}\n`, { mode: 0o600 })
    try {
      chmodSync(this.path, 0o600)
    } catch {}
  }

  delete(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {}
  }
}

class MacKeychainApiAuthStore implements ApiAuthStore {
  readonly name = 'macos-keychain'

  read(): string | undefined {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', SERVICE_NAME, '-a', keychainAccount(), '-w'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    if (result.status !== 0) return undefined
    const verifier = result.stdout.trim()
    return verifier === '' ? undefined : verifier
  }

  write(verifier: string): void {
    // Feed the subcommand (secret included) on stdin via interactive mode so the
    // verifier never appears in argv, where `ps` would expose it.
    const result = spawnSync('security', ['-i'], {
      encoding: 'utf8',
      input: buildMacKeychainAddInput(SERVICE_NAME, keychainAccount(), verifier),
      windowsHide: true,
    })
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'security failed')
  }
}

class LinuxSecretServiceApiAuthStore implements ApiAuthStore {
  readonly name = 'secret-service'

  read(): string | undefined {
    const result = spawnSync('secret-tool', ['lookup', ...SECRET_ATTRIBUTES], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0) return undefined
    const verifier = result.stdout.trim()
    return verifier === '' ? undefined : verifier
  }

  write(verifier: string): void {
    const result = spawnSync(
      'secret-tool',
      ['store', '--label', 'Hyprmnesia API token', ...SECRET_ATTRIBUTES],
      {
        encoding: 'utf8',
        input: `${verifier}\n`,
        windowsHide: true,
      },
    )
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'secret-tool failed')
  }
}

class WindowsDpapiApiAuthStore implements ApiAuthStore {
  readonly name = 'windows-dpapi-file'

  constructor(private readonly path = join(homedir(), '.hyprmnesia', 'api-token.hash.dpapi')) {}

  read(): string | undefined {
    if (!existsSync(this.path)) return undefined
    const script = `
$ErrorActionPreference = 'Stop'
[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$path = ${psQuote(this.path)}
if (!(Test-Path -LiteralPath $path)) { exit 2 }
$raw = [IO.File]::ReadAllText($path)
$bytes = [Convert]::FromBase64String($raw)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`
    const result = runPowerShell(script)
    if (result.status !== 0) return undefined
    const verifier = result.stdout.trim()
    return verifier === '' ? undefined : verifier
  }

  write(verifier: string): void {
    const script = `
$ErrorActionPreference = 'Stop'
[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$path = ${psQuote(this.path)}
$dir = Split-Path -Parent $path
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$plain = [Text.Encoding]::UTF8.GetBytes($env:HPM_API_VERIFIER)
$bytes = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText($path, [Convert]::ToBase64String($bytes))
`
    const result = runPowerShell(script, { HPM_API_VERIFIER: verifier })
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'PowerShell DPAPI failed')
  }
}

export class CachedApiAuthStore implements ApiAuthStore {
  readonly name: string
  private cached: string | undefined

  constructor(private readonly inner: ApiAuthStore) {
    this.name = inner.name
  }

  read(): string | undefined {
    if (this.cached?.startsWith(VERIFIER_PREFIX)) return this.cached
    const verifier = this.inner.read()
    if (verifier?.startsWith(VERIFIER_PREFIX)) this.cached = verifier
    return verifier
  }

  write(verifier: string): void {
    this.inner.write(verifier)
    this.cached = verifier
  }

  delete(): void {
    this.inner.delete?.()
    this.cached = undefined
  }
}

export class CompositeApiAuthStore implements ApiAuthStore {
  readonly name: string

  constructor(private readonly stores: ApiAuthStore[]) {
    this.name = stores.map((store) => store.name).join(' -> ')
  }

  read(): string | undefined {
    for (const store of this.stores) {
      try {
        const verifier = store.read()
        if (verifier) return verifier
      } catch {}
    }
    return undefined
  }

  write(verifier: string): void {
    let lastError: unknown
    for (let index = 0; index < this.stores.length; index++) {
      const store = this.stores[index]!
      try {
        store.write(verifier)
        this.clearLowerPriorityStores(index + 1)
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  delete(): void {
    for (const store of this.stores) {
      try {
        store.delete?.()
      } catch {}
    }
  }

  private clearLowerPriorityStores(fromIndex: number): void {
    for (const store of this.stores.slice(fromIndex)) {
      try {
        store.delete?.()
      } catch {}
    }
  }
}

export function createDefaultApiAuthStore(): ApiAuthStore {
  const file = new FileApiAuthStore()
  if (process.platform === 'win32')
    return new CachedApiAuthStore(new CompositeApiAuthStore([new WindowsDpapiApiAuthStore(), file]))
  if (process.platform === 'darwin' && commandExists('security')) {
    return new CachedApiAuthStore(new CompositeApiAuthStore([new MacKeychainApiAuthStore(), file]))
  }
  if (process.platform === 'linux' && commandExists('secret-tool')) {
    return new CachedApiAuthStore(
      new CompositeApiAuthStore([new LinuxSecretServiceApiAuthStore(), file]),
    )
  }
  return new CachedApiAuthStore(file)
}

export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashApiToken(token: string): string {
  return `${VERIFIER_PREFIX}${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

export function isValidApiTokenShape(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length
}

export function verifyApiToken(
  token: string | undefined,
  store: ApiAuthStore,
): true | ApiAuthFailure {
  if (!token) return 'missing_token'
  const verifier = store.read()
  if (!verifier || !verifier.startsWith(VERIFIER_PREFIX)) return 'unconfigured'
  if (!isValidApiTokenShape(token)) return 'invalid_token'
  return constantTimeEqual(hashApiToken(token), verifier) ? true : 'invalid_token'
}

export function isApiAuthConfigured(store: ApiAuthStore): boolean {
  return Boolean(store.read()?.startsWith(VERIFIER_PREFIX))
}

export function apiAuthFailureMessage(reason: ApiAuthFailure): string {
  if (reason === 'missing_token') {
    return 'API auth token missing. Send it as a Bearer token: Authorization: Bearer <token>.'
  }
  if (reason === 'unconfigured') {
    return 'API auth token is not configured. Run `hpm api auth setup` and pass the printed token to your API client.'
  }
  return 'API auth token is invalid. Check the Bearer token you are sending or run `hpm api auth rotate`.'
}

export function apiAuthStatus(enabled: boolean, store: ApiAuthStore): ApiAuthStatus {
  return {
    enabled,
    configured: isApiAuthConfigured(store),
    backend: store.name,
  }
}

export function setupApiAuth(store: ApiAuthStore = createDefaultApiAuthStore()): {
  token?: string
  alreadyConfigured: boolean
  backend: string
} {
  const current = store.read()
  if (current?.startsWith(VERIFIER_PREFIX)) {
    return { alreadyConfigured: true, backend: store.name }
  }
  return rotateApiAuth(store)
}

export function rotateApiAuth(store: ApiAuthStore = createDefaultApiAuthStore()): {
  token: string
  alreadyConfigured: false
  backend: string
} {
  const token = generateApiToken()
  store.write(hashApiToken(token))
  return { token, alreadyConfigured: false, backend: store.name }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    const padded = Buffer.alloc(Math.max(left.length, right.length))
    timingSafeEqual(padded, Buffer.alloc(padded.length))
    return false
  }
  return timingSafeEqual(left, right)
}

function defaultVerifierPath(): string {
  return join(homedir(), '.hyprmnesia', 'api-token.hash')
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(lookup, [command], {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  })
  return result.status === 0
}

function keychainAccount(): string {
  return process.env.USER || process.env.USERNAME || 'default'
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function runPowerShell(script: string, extraEnv: Record<string, string> = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    },
  )
}
