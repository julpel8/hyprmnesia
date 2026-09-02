// Request guards for the ephemeral local UI server. There is no token: the
// server binds a random 127.0.0.1 port and serves whoever asks, so any process
// on this machine can read the index.
//
// The browser is handled separately. No Access-Control-Allow-Origin header is
// ever sent, so a cross-origin page cannot read a response. What it could still
// do is fire off a blind state-changing request (stop the daemon, rewrite the
// config), which is what the Origin check below refuses.

export function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Cache-Control': 'no-store', ...extra }
}

// True when a state-changing request is allowed to proceed. GET/HEAD are exempt
// (read-only). Anything else must either carry our own origin or carry none at
// all — `curl` and other non-browser clients send no Origin, and they already
// have full local access anyway.
export function isSameOriginRequest(req: Request, selfOrigin: string): boolean {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = req.headers.get('origin')
  if (origin === null) return true
  return origin === selfOrigin
}
