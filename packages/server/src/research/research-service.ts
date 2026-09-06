/**
 * Narrow adapter over the existing research HTTP boundary.
 *
 * This is deliberately a router adapter rather than a second implementation of
 * campaign mutation.  The ledger is where optimistic versions, idempotency,
 * exact approval scopes and execution-device binding are enforced.
 */
import { handleResearchApi } from '../api/research.ts'
import type { ApiRequestDeps } from '../api/types.ts'

export type ResearchControlOperation =
  | 'prepare'
  | 'propose'
  | 'submit'
  | 'status'
  | 'events'
  | 'cancel'
  | 'reconcile'
  | 'receipt'
  | 'request_review'

export interface ResearchControlRequest {
  operation: ResearchControlOperation
  /** Required except for a prepare request that creates a campaign. */
  campaignId?: string
  body?: unknown
}

export const RESEARCH_CONTROL_OPERATIONS = new Set<ResearchControlOperation>([
  'prepare',
  'propose',
  'submit',
  'status',
  'events',
  'cancel',
  'reconcile',
  'receipt',
  'request_review',
])

const paths: Record<Exclude<ResearchControlOperation, 'prepare'>, string> = {
  propose: 'proposals',
  submit: 'synthetic',
  status: '',
  events: 'events',
  cancel: 'synthetic/cancel',
  reconcile: 'synthetic/reconcile',
  receipt: 'synthetic/receipt',
  request_review: 'review',
}

/**
 * Presents one safe control surface while retaining the established API as the
 * policy decision point.  No operation maps to approve, revoke, labelset, or
 * release, and the bridge never forwards a human-proof header.
 */
export class ResearchControlApiAdapter {
  constructor(private readonly deps: ApiRequestDeps) {}

  async execute(request: ResearchControlRequest): Promise<Response> {
    if (!RESEARCH_CONTROL_OPERATIONS.has(request.operation))
      return jsonError('invalid_research_control_operation', 400)
    const campaignId = request.campaignId?.trim()
    if (request.operation !== 'prepare' && !campaignId)
      return jsonError('campaign_id_required', 400)

    let method = 'POST'
    let path = '/api/research/campaigns'
    if (request.operation === 'prepare') {
      // A campaign id prepares by reading the current ledger projection.  With
      // no id it performs the existing idempotent campaign creation operation.
      if (campaignId) {
        method = 'GET'
        path += `/${encodeURIComponent(campaignId)}`
      }
    } else {
      const suffix = paths[request.operation]
      method = ['status', 'events', 'receipt'].includes(request.operation) ? 'GET' : 'POST'
      path += `/${encodeURIComponent(campaignId!)}${suffix ? `/${suffix}` : ''}`
    }
    const url = new URL(`http://research-control.invalid${path}`)
    if (method === 'GET' && request.body && typeof request.body === 'object') {
      for (const [key, value] of Object.entries(request.body as Record<string, unknown>)) {
        if (typeof value === 'string') url.searchParams.set(key, value)
      }
    }
    const req = new Request(url.toString(), {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body ?? {}),
          }
        : {}),
    })
    return (
      (await handleResearchApi(url, req, this.deps)) ?? jsonError('research_route_unavailable', 404)
    )
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
