import { expect, test } from 'bun:test'
import {
  buildMacKeychainAddInput,
  CachedMcpAuthStore,
  CompositeMcpAuthStore,
  generateMcpToken,
  hashMcpToken,
  isMcpAuthConfigured,
  isValidMcpTokenShape,
  type McpAuthStore,
  MemoryMcpAuthStore,
  mcpAuthStatus,
  rotateMcpAuth,
  setupMcpAuth,
  verifyMcpToken,
} from './auth'

class TestStore implements McpAuthStore {
  readCount = 0
  writeCount = 0
  deleteCount = 0
  verifier: string | undefined

  constructor(
    readonly name: string,
    private readonly opts: { throwRead?: boolean; throwWrite?: boolean } = {},
  ) {}

  read(): string | undefined {
    this.readCount++
    if (this.opts.throwRead) throw new Error(`${this.name} read failed`)
    return this.verifier
  }

  write(verifier: string): void {
    this.writeCount++
    if (this.opts.throwWrite) throw new Error(`${this.name} write failed`)
    this.verifier = verifier
  }

  delete(): void {
    this.deleteCount++
    this.verifier = undefined
  }
}

test('generateMcpToken uses the public MCP token prefix', () => {
  const token = generateMcpToken()
  expect(token.startsWith('hpm_mcp_')).toBe(true)
  expect(isValidMcpTokenShape(token)).toBe(true)
})

test('hashMcpToken stores only a sha256 verifier', () => {
  const token = 'hpm_mcp_test-token'
  const verifier = hashMcpToken(token)
  expect(verifier.startsWith('sha256:')).toBe(true)
  expect(verifier).not.toContain(token)
})

test('verifyMcpToken rejects missing, unconfigured, malformed, and invalid tokens', () => {
  const store = new MemoryMcpAuthStore()
  expect(verifyMcpToken(undefined, store)).toBe('missing_token')
  expect(verifyMcpToken('hpm_mcp_anything', store)).toBe('unconfigured')

  const token = generateMcpToken()
  store.write(hashMcpToken(token))
  expect(verifyMcpToken('not-an-hpm-token', store)).toBe('invalid_token')
  expect(verifyMcpToken(`${token}x`, store)).toBe('invalid_token')
})

test('verifyMcpToken accepts the matching token', () => {
  const store = new MemoryMcpAuthStore()
  const token = generateMcpToken()
  store.write(hashMcpToken(token))
  expect(verifyMcpToken(token, store)).toBe(true)
})

test('setupMcpAuth creates once and does not print an existing token again', () => {
  const store = new MemoryMcpAuthStore()
  const first = setupMcpAuth(store)
  expect(first.alreadyConfigured).toBe(false)
  expect(first.token?.startsWith('hpm_mcp_')).toBe(true)

  const second = setupMcpAuth(store)
  expect(second.alreadyConfigured).toBe(true)
  expect(second.token).toBeUndefined()
})

test('rotateMcpAuth replaces the verifier and invalidates the old token', () => {
  const store = new MemoryMcpAuthStore()
  const first = rotateMcpAuth(store).token
  expect(verifyMcpToken(first, store)).toBe(true)

  const second = rotateMcpAuth(store).token
  expect(second).not.toBe(first)
  expect(verifyMcpToken(first, store)).toBe('invalid_token')
  expect(verifyMcpToken(second, store)).toBe(true)
})

test('mcpAuthStatus reports enabled and configured state without exposing token material', () => {
  const store = new MemoryMcpAuthStore()
  expect(mcpAuthStatus(true, store)).toEqual({
    enabled: true,
    configured: false,
    backend: 'memory',
  })

  const token = generateMcpToken()
  store.write(hashMcpToken(token))
  expect(mcpAuthStatus(false, store)).toEqual({
    enabled: false,
    configured: true,
    backend: 'memory',
  })
})

test('CachedMcpAuthStore caches configured verifier reads', () => {
  const inner = new TestStore('inner')
  const token = generateMcpToken()
  inner.write(hashMcpToken(token))
  const cached = new CachedMcpAuthStore(inner)

  expect(verifyMcpToken(token, cached)).toBe(true)
  expect(verifyMcpToken(token, cached)).toBe(true)
  expect(inner.readCount).toBe(1)
})

test('CachedMcpAuthStore does not cache a missing verifier', () => {
  const inner = new TestStore('inner')
  const token = generateMcpToken()
  const cached = new CachedMcpAuthStore(inner)

  expect(isMcpAuthConfigured(cached)).toBe(false)
  inner.write(hashMcpToken(token))
  expect(verifyMcpToken(token, cached)).toBe(true)
  expect(inner.readCount).toBe(2)
})

test('CompositeMcpAuthStore writes to the first available backend and clears lower-priority fallback', () => {
  const primary = new TestStore('primary')
  const fallback = new TestStore('fallback')
  fallback.write(hashMcpToken(generateMcpToken()))

  const token = generateMcpToken()
  const composite = new CompositeMcpAuthStore([primary, fallback])
  composite.write(hashMcpToken(token))

  expect(primary.writeCount).toBe(1)
  expect(fallback.writeCount).toBe(1)
  expect(fallback.deleteCount).toBe(1)
  expect(fallback.verifier).toBeUndefined()
  expect(verifyMcpToken(token, composite)).toBe(true)
})

test('CompositeMcpAuthStore falls back when the primary backend cannot write', () => {
  const primary = new TestStore('primary', { throwWrite: true })
  const fallback = new TestStore('fallback')

  const token = generateMcpToken()
  const composite = new CompositeMcpAuthStore([primary, fallback])
  composite.write(hashMcpToken(token))

  expect(primary.writeCount).toBe(1)
  expect(fallback.writeCount).toBe(1)
  expect(verifyMcpToken(token, composite)).toBe(true)
})

test('buildMacKeychainAddInput: keeps the secret on stdin, quotes service/account', () => {
  const line = buildMacKeychainAddInput('hyprmnesia-mcp-token', 'julien', 'deadbeef')
  expect(line).toBe('add-generic-password -U -s "hyprmnesia-mcp-token" -a "julien" -w deadbeef\n')
})

test('buildMacKeychainAddInput: accepts sha256: verifiers and base64url tokens', () => {
  expect(() => buildMacKeychainAddInput('s', 'a', 'sha256:abc123')).not.toThrow()
  expect(() => buildMacKeychainAddInput('s', 'a', 'hpm_mcp_aB-_9=')).not.toThrow()
})

test('buildMacKeychainAddInput: rejects values with quoting/shell metacharacters', () => {
  expect(() => buildMacKeychainAddInput('s', 'a', 'has space')).toThrow(/unsafe/)
  expect(() => buildMacKeychainAddInput('s', 'a', 'quote"inside')).toThrow(/unsafe/)
  expect(() => buildMacKeychainAddInput('s', 'a', 'a\nb')).toThrow(/unsafe/)
})
