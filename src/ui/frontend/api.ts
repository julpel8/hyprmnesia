// Thin fetch client for the local UI API. The server is unauthenticated; it only
// checks that a write comes from its own origin, which the browser fills in for
// us on same-origin requests.

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  return fetch(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin' })
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function postJson<T>(
  path: string,
  body: unknown,
  opts: { keepalive?: boolean } = {},
): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: opts.keepalive,
  })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return (await res.json()) as T
}

export function ping(): void {
  void request('/api/ping').catch(() => {})
}
