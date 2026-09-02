// Settings editor routes. GET returns the normalized config plus the shared
// field descriptors (label/path/kind/choices) computed server-side, since
// settingsFields() reads process.platform. PUT saves an edited config through
// saveConfig() (which normalizes) and can restart the daemon.

import { type Config, loadConfigForEditing, saveConfig } from '../../config'
import type { Orchestrator } from '../../core/orchestrator'
import { settingsFields } from '../../core/settings_fields'
import { restartDaemon } from './daemon'

export interface ConfigContext {
  orchestrator: Orchestrator
  headers: (extra?: Record<string, string>) => Record<string, string>
}

function configResponse(ctx: ConfigContext): Response {
  const config = loadConfigForEditing()
  return Response.json({ config, fields: settingsFields(config) }, { headers: ctx.headers() })
}

export async function handleConfigRequest(
  req: Request,
  url: URL,
  ctx: ConfigContext,
): Promise<Response | undefined> {
  if (url.pathname !== '/api/config') return undefined

  if (req.method === 'GET') return configResponse(ctx)

  if (req.method === 'PUT') {
    let body: { config?: unknown; restart?: boolean }
    try {
      body = (await req.json()) as { config?: unknown; restart?: boolean }
    } catch {
      return new Response('invalid JSON', { status: 400, headers: ctx.headers() })
    }
    if (!body.config || typeof body.config !== 'object') {
      return new Response('config object required', { status: 400, headers: ctx.headers() })
    }
    try {
      saveConfig(body.config as Config)
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), {
        status: 400,
        headers: ctx.headers(),
      })
    }
    if (body.restart) await restartDaemon(ctx.orchestrator)
    return configResponse(ctx)
  }

  return new Response('method not allowed', { status: 405, headers: ctx.headers() })
}
