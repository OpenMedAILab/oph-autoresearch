import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApiRequestDeps } from '../api/types.ts'
import type { NativeResearchControlBridge } from '../cli-conversation.ts'
import { ResearchControlApiAdapter, type ResearchControlRequest } from './research-service.ts'

/**
 * Ephemeral loopback bridge for one native CLI turn.  The native child receives
 * only this random token, never the application bearer token.  Its campaign
 * allowlist is checked before the ledger adapter sees a request.
 */
export function createNativeResearchControlBridge(
  deps: ApiRequestDeps,
  campaignIds: readonly string[],
  signal: AbortSignal,
): NativeResearchControlBridge & { close(): void } {
  const token = randomBytes(32).toString('hex')
  const allowed = new Set(campaignIds)
  const adapter = new ResearchControlApiAdapter(deps)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      if (
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/research/control')
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
      const raw: unknown = await request.json().catch(() => null)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
      const control = raw as ResearchControlRequest
      if (control.campaignId && !allowed.has(control.campaignId))
        return new Response(JSON.stringify({ error: 'campaign_not_allowed' }), { status: 403 })
      return adapter.execute(control)
    },
  })
  const close = () => server.stop(true)
  signal.addEventListener('abort', close, { once: true })
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    token,
    campaignIds,
    close: () => {
      signal.removeEventListener('abort', close)
      close()
    },
  }
}
