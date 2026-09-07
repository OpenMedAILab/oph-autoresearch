export type ResearchControlOperation =
  | 'list'
  | 'preflight'
  | 'knowledge/search'
  | 'context'
  | 'workflow/preset'
  | 'literature/import'
  | 'evidence/fetch'
  | 'prepare'
  | 'propose'
  | 'submit'
  | 'status'
  | 'events'
  | 'next_actions'
  | 'cancel'
  | 'reconcile'
  | 'receipt'
  | 'request_review'
  | 'documents/read'
  | 'record_document/write'
  | 'cli_preparation/propose'
  | 'cli_preparation/submit'
  | 'cli_preparation/status'
  | 'cli_preparation/cancel'
  | 'cli_preparation/reconcile'
  | 'cli_preparation/catalog'

/** Model-facing capability: it deliberately contains no approval, signing, or release action. */
export interface ResearchControlPort {
  execute(input: {
    operation: ResearchControlOperation
    campaignId: string
    body?: Record<string, unknown>
  }): Promise<{ ok: boolean; status: number; data: unknown }>
}
