import { expect, test } from 'bun:test'
import {
  type ApiAuthStore,
  apiAuthStatus,
  buildMacKeychainAddInput,
  CachedApiAuthStore,
  CompositeApiAuthStore,
  generateApiToken,
  hashApiToken,
  isApiAuthConfigured,
  isValidApiTokenShape,
  MemoryApiAuthStore,
  rotateApiAuth,
  setupApiAuth,
  verifyApiToken,
} from './auth'

class TestStore implements ApiAuthStore {
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

test('generateApiToken uses the public API token prefix', () => {
  const token = generateApiToken()
  expect(token.startsWith('hpm_api_')).toBe(true)
  expect(isValidApiTokenShape(token)).toBe(true)
})

test('hashApiToken stores only a sha256 verifier', () => {
  const token = 'hpm_api_test-token'
  const verifier = hashApiToken(token)
  expect(verifier.startsWith('sha256:')).toBe(true)
  expect(verifier).not.toContain(token)
})

test('verifyApiToken rejects missing, unconfigured, malformed, and invalid tokens', () => {
  const store = new MemoryApiAuthStore()
  expect(verifyApiToken(undefined, store)).toBe('missing_token')
  expect(verifyApiToken('hpm_api_anything', store)).toBe('unconfigured')

  const token = generateApiToken()
  store.write(hashApiToken(token))
  expect(verifyApiToken('not-an-hpm-token', store)).toBe('invalid_token')
  expect(verifyApiToken(`${token}x`, store)).toBe('invalid_token')
})

test('verifyApiToken accepts the matching token', () => {
  const store = new MemoryApiAuthStore()
  const token = generateApiToken()
  store.write(hashApiToken(token))
  expect(verifyApiToken(token, store)).toBe(true)
})

test('setupApiAuth creates once and does not print an existing token again', () => {
  const store = new MemoryApiAuthStore()
  const first = setupApiAuth(store)
  expect(first.alreadyConfigured).toBe(false)
  expect(first.token?.startsWith('hpm_api_')).toBe(true)

  const second = setupApiAuth(store)
  expect(second.alreadyConfigured).toBe(true)
  expect(second.token).toBeUndefined()
})

test('rotateApiAuth replaces the verifier and invalidates the old token', () => {
  const store = new MemoryApiAuthStore()
  const first = rotateApiAuth(store).token
  expect(verifyApiToken(first, store)).toBe(true)

  const second = rotateApiAuth(store).token
  expect(second).not.toBe(first)
  expect(verifyApiToken(first, store)).toBe('invalid_token')
  expect(verifyApiToken(second, store)).toBe(true)
})

test('apiAuthStatus reports enabled and configured state without exposing token material', () => {
  const store = new MemoryApiAuthStore()
  expect(apiAuthStatus(true, store)).toEqual({
    enabled: true,
    configured: false,
    backend: 'memory',
  })

  const token = generateApiToken()
  store.write(hashApiToken(token))
  expect(apiAuthStatus(false, store)).toEqual({
    enabled: false,
    configured: true,
    backend: 'memory',
  })
})

test('CachedApiAuthStore caches configured verifier reads', () => {
  const inner = new TestStore('inner')
  const token = generateApiToken()
  inner.write(hashApiToken(token))
  const cached = new CachedApiAuthStore(inner)

  expect(verifyApiToken(token, cached)).toBe(true)
  expect(verifyApiToken(token, cached)).toBe(true)
  expect(inner.readCount).toBe(1)
})

test('CachedApiAuthStore does not cache a missing verifier', () => {
  const inner = new TestStore('inner')
  const token = generateApiToken()
  const cached = new CachedApiAuthStore(inner)

  expect(isApiAuthConfigured(cached)).toBe(false)
  inner.write(hashApiToken(token))
  expect(verifyApiToken(token, cached)).toBe(true)
  expect(inner.readCount).toBe(2)
})

test('CompositeApiAuthStore writes to the first available backend and clears lower-priority fallback', () => {
  const primary = new TestStore('primary')
  const fallback = new TestStore('fallback')
  fallback.write(hashApiToken(generateApiToken()))

  const token = generateApiToken()
  const composite = new CompositeApiAuthStore([primary, fallback])
  composite.write(hashApiToken(token))

  expect(primary.writeCount).toBe(1)
  expect(fallback.writeCount).toBe(1)
  expect(fallback.deleteCount).toBe(1)
  expect(fallback.verifier).toBeUndefined()
  expect(verifyApiToken(token, composite)).toBe(true)
})

test('CompositeApiAuthStore falls back when the primary backend cannot write', () => {
  const primary = new TestStore('primary', { throwWrite: true })
  const fallback = new TestStore('fallback')

  const token = generateApiToken()
  const composite = new CompositeApiAuthStore([primary, fallback])
  composite.write(hashApiToken(token))

  expect(primary.writeCount).toBe(1)
  expect(fallback.writeCount).toBe(1)
  expect(verifyApiToken(token, composite)).toBe(true)
})

test('buildMacKeychainAddInput: keeps the secret on stdin, quotes service/account', () => {
  const line = buildMacKeychainAddInput('hyprmnesia-api-token', 'julien', 'deadbeef')
  expect(line).toBe('add-generic-password -U -s "hyprmnesia-api-token" -a "julien" -w deadbeef\n')
})

test('buildMacKeychainAddInput: accepts sha256: verifiers and base64url tokens', () => {
  expect(() => buildMacKeychainAddInput('s', 'a', 'sha256:abc123')).not.toThrow()
  expect(() => buildMacKeychainAddInput('s', 'a', 'hpm_api_aB-_9=')).not.toThrow()
})

test('buildMacKeychainAddInput: rejects values with quoting/shell metacharacters', () => {
  expect(() => buildMacKeychainAddInput('s', 'a', 'has space')).toThrow(/unsafe/)
  expect(() => buildMacKeychainAddInput('s', 'a', 'quote"inside')).toThrow(/unsafe/)
  expect(() => buildMacKeychainAddInput('s', 'a', 'a\nb')).toThrow(/unsafe/)
})
