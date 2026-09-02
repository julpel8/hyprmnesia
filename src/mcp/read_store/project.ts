// Conservative, deterministic project-context extraction (#86). Every rule
// only fires on structure that directly encodes the fact it reports; when
// nothing matches the answer is null, never a guess.

export interface ProjectContext {
  repo: string | null
  branch: string | null
  ssh_host: string | null
  source: 'window_title'
}

// Editors that put "<file> - <folder> - <Product>" in the window title.
const EDITOR_TITLE_PRODUCTS = new Set([
  'visual studio code',
  'visual studio code - insiders',
  'code',
  'code - oss',
  'vscodium',
  'cursor',
])

// Only the two title shapes that unambiguously mean a shell on a remote host:
// "ssh user@host" and the terminal-prompt style "user@host: ~/path". A bare
// "user@host" is indistinguishable from an email address, so it never matches.
const SSH_TITLE_RE =
  /(?:^|\s)(?:ssh\s+([a-z_][\w.-]*)@([a-z0-9][\w.-]*[a-z0-9])(?=[:\s/]|$)|([a-z_][\w.-]*)@([a-z0-9][\w.-]*[a-z0-9]):)/i

export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  if (!host) return null
  return host.startsWith('www.') ? host.slice(4) : host
}

// "repo [branch]" — the bracketed branch some editors append to the folder
// segment when a workspace shows SCM state.
function splitRepoBranch(segment: string): { repo: string; branch: string | null } {
  const match = segment.match(/^(.*\S)\s+\[([^[\]\s]+)\]$/)
  if (match?.[1] && match[2]) return { repo: match[1], branch: match[2] }
  return { repo: segment, branch: null }
}

export function parseProjectContext(title: string | null | undefined): ProjectContext | null {
  if (!title) return null
  const trimmed = title.trim()
  if (trimmed === '') return null

  // VS Code-family: "<file> - <folder> - <Product>" (en or em dash separators).
  // Require the trailing product name so plain hyphenated titles never match.
  const segments = trimmed.split(/\s[-–—]\s/)
  if (segments.length >= 3) {
    const product = segments[segments.length - 1]?.trim().toLowerCase()
    const folder = segments[segments.length - 2]?.trim()
    if (product && folder && EDITOR_TITLE_PRODUCTS.has(product)) {
      const { repo, branch } = splitRepoBranch(folder)
      return { repo, branch, ssh_host: null, source: 'window_title' }
    }
  }

  // Terminal ssh sessions: "ssh user@host" or "user@host: ~/path".
  const ssh = trimmed.match(SSH_TITLE_RE)
  const host = ssh?.[2] ?? ssh?.[4]
  if (host) {
    return { repo: null, branch: null, ssh_host: host, source: 'window_title' }
  }

  return null
}
