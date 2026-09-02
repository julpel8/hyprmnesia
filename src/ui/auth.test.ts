import { expect, test } from 'bun:test'
import { isSameOriginRequest, noStoreHeaders } from './auth'

const SELF = 'http://127.0.0.1:4321'

function req(method: string, origin?: string): Request {
  return new Request(`${SELF}/api/config`, {
    method,
    headers: origin === undefined ? {} : { origin },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  })
}

test('noStoreHeaders always sets no-store and keeps the extras', () => {
  expect(noStoreHeaders({ 'Content-Type': 'text/html' })).toEqual({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html',
  })
})

test('reads are always allowed, whatever the origin', () => {
  expect(isSameOriginRequest(req('GET', 'https://evil.example'), SELF)).toBe(true)
  expect(isSameOriginRequest(req('HEAD', 'https://evil.example'), SELF)).toBe(true)
})

test('a write from another origin is refused', () => {
  expect(isSameOriginRequest(req('POST', 'https://evil.example'), SELF)).toBe(false)
  expect(isSameOriginRequest(req('POST', 'http://127.0.0.1:9999'), SELF)).toBe(false)
})

test('a write from our own page is allowed', () => {
  expect(isSameOriginRequest(req('POST', SELF), SELF)).toBe(true)
})

test('a write with no Origin header is allowed (curl and other local clients)', () => {
  expect(isSameOriginRequest(req('POST'), SELF)).toBe(true)
})
