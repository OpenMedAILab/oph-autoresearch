import {
  RESEARCH_CONTROL_OPERATIONS,
  ResearchControlApiAdapter,
  type ResearchControlOperation,
} from '../research/research-service.ts'
import { type ApiHandler, json } from './types.ts'

/**
 * Shared API/CLI control ingress.  It intentionally has no approval or
 * release verb: human signing stays on the separate authenticated API route.
 */
export const handleResearchControlApi: ApiHandler = async (url, req, d) => {
  if (url.pathname !== '/api/research/control') return null
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const raw: unknown = await req.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return json({ error: 'invalid_request' }, 400)
  const input = raw as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !['operation', 'campaignId', 'body'].includes(key)) ||
    typeof input.operation !== 'string' ||
    !RESEARCH_CONTROL_OPERATIONS.has(input.operation as ResearchControlOperation) ||
    (input.campaignId !== undefined && typeof input.campaignId !== 'string')
  )
    return json({ error: 'invalid_research_control_request' }, 400)
  return new ResearchControlApiAdapter(d).execute({
    operation: input.operation as ResearchControlOperation,
    ...(typeof input.campaignId === 'string' ? { campaignId: input.campaignId } : {}),
    ...(input.body === undefined ? {} : { body: input.body }),
  })
}
