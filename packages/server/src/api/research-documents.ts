import { getResearchCampaign } from '@oph-autoresearch/store'
import {
  ResearchDocumentError,
  type ResearchDocumentKind,
  readResearchDocuments,
  writeResearchDocument,
} from '../research/research-documents.ts'
import { publishResearchEvents } from '../research-events.ts'
import { type ApiHandler, json } from './types.ts'

function exactBody(value: unknown): value is {
  expectedVersion: number
  idempotencyKey: string
  kind: ResearchDocumentKind
  document: Record<string, unknown>
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = Object.keys(body).sort()
  return (
    keys.length === 4 &&
    keys.every(
      (key, index) => key === ['document', 'expectedVersion', 'idempotencyKey', 'kind'][index],
    ) &&
    typeof body.expectedVersion === 'number' &&
    Number.isSafeInteger(body.expectedVersion) &&
    body.expectedVersion > 0 &&
    typeof body.idempotencyKey === 'string' &&
    ['study', 'manuscript', 'skillcandidate'].includes(String(body.kind)) &&
    !!body.document &&
    typeof body.document === 'object' &&
    !Array.isArray(body.document)
  )
}

/** Immutable campaign documents. This route is deliberately separate from mutable research proposals. */
export const handleResearchDocumentsApi: ApiHandler = async (url, req, d) => {
  const match = /^\/api\/research\/campaigns\/([A-Za-z0-9_-]+)\/documents$/.exec(url.pathname)
  if (!match) return null
  const campaign = getResearchCampaign(d.store, match[1]!)
  if (!campaign || campaign.workspaceId !== d.workspaceId) return json({ error: 'not_found' }, 404)
  if (req.method === 'GET') {
    try {
      return json({ documents: await readResearchDocuments(d.store, d.workspaceRoot, campaign.id) })
    } catch (error) {
      const status = error instanceof ResearchDocumentError ? error.status : 409
      return json(
        { error: error instanceof Error ? error.message : 'document_read_failed' },
        status,
      )
    }
  }
  if (req.method !== 'POST')
    return new Response('', { status: 405, headers: { allow: 'GET, POST' } })
  const body = await req.json().catch(() => null)
  if (!exactBody(body)) return json({ error: 'invalid_document' }, 400)
  try {
    const result = await writeResearchDocument({
      store: d.store,
      workspaceRoot: d.workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      kind: body.kind,
      document: body.document,
    })
    publishResearchEvents(d.store, d.bus, d.researchNotifications)
    return json(result, result.replayed ? 200 : 201)
  } catch (error) {
    const status = error instanceof ResearchDocumentError ? error.status : 409
    return json({ error: error instanceof Error ? error.message : 'document_write_failed' }, status)
  }
}
