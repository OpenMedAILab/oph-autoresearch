import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ResearchControlPort } from '@oph-autoresearch/core'
import {
  getConversation,
  getResearchCampaign,
  listResearchCampaigns,
} from '@oph-autoresearch/store'
import type { ApiRequestDeps } from '../api/types.ts'
import type { NativeResearchControlBridge } from '../cli-conversation.ts'
import { researchReadiness } from './readiness.ts'
import { assistantContext } from './research-assistant.ts'
import { readResearchDocuments } from './research-documents.ts'
import { RESEARCH_CONTROL_OPERATIONS, ResearchControlApiAdapter } from './research-service.ts'

/**
 * Ephemeral loopback bridge for one native CLI turn.  The native child receives
 * only this random token, never the application bearer token.  Its campaign
 * allowlist is checked before the ledger adapter sees a request.
 */
export function createNativeResearchControlBridge(
  deps: ApiRequestDeps,
  campaignIds: readonly string[],
  signal: AbortSignal,
  expiresAt = Date.now() + 10 * 60_000,
  conversationId?: string,
): NativeResearchControlBridge & { close(): void } {
  const token = randomBytes(32).toString('hex')
  const port = createResearchControlPort(deps, campaignIds, conversationId)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (Date.now() >= expiresAt)
        return new Response(JSON.stringify({ error: 'bridge_expired' }), { status: 410 })
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
      const control = raw as Record<string, unknown>
      if (
        typeof control.operation !== 'string' ||
        (control.campaignId != null && typeof control.campaignId !== 'string') ||
        (control.body != null &&
          (!control.body || typeof control.body !== 'object' || Array.isArray(control.body)))
      )
        return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
      const result = await port.execute({
        operation: control.operation as Parameters<ResearchControlPort['execute']>[0]['operation'],
        campaignId: typeof control.campaignId === 'string' ? control.campaignId : '',
        ...(control.body ? { body: control.body as Record<string, unknown> } : {}),
      })
      return new Response(JSON.stringify(result.data), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const close = () => server.stop(true)
  signal.addEventListener('abort', close, { once: true })
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    token,
    campaignIds,
    ...(conversationId ? { conversationId } : {}),
    close: () => {
      signal.removeEventListener('abort', close)
      close()
    },
  }
}

/** Same campaign/action scope for API-model tools; this is a capability, not a signer. */
export function createResearchControlPort(
  deps: ApiRequestDeps,
  campaignIds: readonly string[],
  conversationId?: string,
): ResearchControlPort {
  const allowed = new Set(campaignIds)
  const adapter = new ResearchControlApiAdapter(deps)
  return {
    async execute(input) {
      if (
        input.operation !== 'list' &&
        input.operation !== 'preflight' &&
        !RESEARCH_CONTROL_OPERATIONS.has(input.operation)
      )
        return { ok: false, status: 400, data: { error: 'invalid_research_control_operation' } }
      const parent = conversationId ? getConversation(deps.store, conversationId as never) : null
      if (
        conversationId &&
        (!parent || parent.workspaceId !== deps.workspaceId || parent.parentConversationId)
      )
        return { ok: false, status: 403, data: { error: 'conversation_not_allowed' } }
      // Re-read ledger facts for every call. The turn allowlist never expands,
      // and deleted or cross-workspace handles cannot be discovered or used.
      const campaigns = (
        conversationId
          ? listResearchCampaigns(deps.store, deps.workspaceId, conversationId).map((c) => c.id)
          : [...allowed]
      ).flatMap((id) => {
        const campaign = getResearchCampaign(deps.store, id)
        return campaign?.workspaceId === deps.workspaceId ? [campaign] : []
      })
      const requested = input.campaignId.trim()
      if (requested && !campaigns.some((campaign) => campaign.id === requested))
        return { ok: false, status: 403, data: { error: 'campaign_not_allowed' } }
      if (input.operation === 'knowledge/search') {
        const query =
          typeof input.body?.query === 'string' ? input.body.query.toLowerCase().slice(0, 200) : ''
        const docs = (
          await Promise.all(
            listResearchCampaigns(deps.store, deps.workspaceId).map((c) =>
              readResearchDocuments(deps.store, deps.workspaceRoot, c.id),
            ),
          )
        ).flat()
        return {
          ok: true,
          status: 200,
          data: {
            documents: docs
              .filter(
                (d) =>
                  ['venue', 'evidence'].includes(d.kind) &&
                  d.verified &&
                  !d.stale &&
                  JSON.stringify(d.document).toLowerCase().includes(query),
              )
              .slice(0, 20),
          },
        }
      }
      if (input.operation === 'context')
        return {
          ok: true,
          status: 200,
          data: await assistantContext(
            deps,
            campaigns.filter((c) => !requested || c.id === requested),
          ),
        }
      if (input.operation === 'prepare' && !requested && conversationId) {
        if (
          typeof input.body?.goal !== 'string' ||
          typeof input.body?.idempotencyKey !== 'string' ||
          Object.keys(input.body).some((key) => !['goal', 'idempotencyKey'].includes(key))
        )
          return { ok: false, status: 400, data: { error: 'goal_and_idempotency_key_required' } }
        const response = await adapter.execute({
          operation: 'prepare',
          body: { ...input.body, parentConversationId: conversationId },
        })
        return { ok: response.ok, status: response.status, data: await response.json() }
      }
      if (input.operation === 'list')
        return {
          ok: true,
          status: 200,
          data: {
            campaigns: campaigns
              .filter((campaign) => !requested || campaign.id === requested)
              .map((campaign) => ({
                campaignId: campaign.id,
                goal: campaign.goal,
                version: campaign.version,
              })),
            message: campaigns.length
              ? '使用工具返回的内部标识继续操作；不要要求用户复制或展示标识。'
              : '本会话还没有研究提案；用 prepare {goal,idempotencyKey} 从主题创建。',
          },
        }
      if (input.operation === 'preflight')
        return { ok: true, status: 200, data: await researchReadiness(deps) }
      const campaignId = requested || (campaigns.length === 1 ? campaigns[0]!.id : '')
      if (!campaignId)
        return {
          ok: false,
          status: 409,
          data: {
            error: campaigns.length ? 'campaign_selection_required' : 'campaign_unavailable',
            message: campaigns.length
              ? '本会话有多个提案，请先 list，按研究目标选择；不向用户索取内部标识。'
              : '本会话尚未创建研究提案；用 prepare {goal,idempotencyKey} 从主题创建。',
          },
        }
      const response = await adapter.execute({ ...input, operation: input.operation, campaignId })
      const data = (await response
        .json()
        .catch(() => ({ error: 'invalid_research_response' }))) as Record<string, unknown>
      if (input.operation === 'documents/read' && Array.isArray(data.documents))
        data.documents = data.documents.filter(
          (item: { kind: string; document?: Record<string, unknown> }) =>
            item.kind !== 'reviewcase' ||
            (item.document?.usage === 'model-context' &&
              item.document?.split === 'train' &&
              item.document?.sourceKind !== 'synthetic'),
        )
      return { ok: response.ok, status: response.status, data }
    },
  }
}
