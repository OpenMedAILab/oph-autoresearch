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

/** Model-facing capability: it deliberately contains no approval, signing, or release action. */
export interface ResearchControlPort {
  execute(input: {
    operation: ResearchControlOperation
    campaignId: string
    body?: Record<string, unknown>
  }): Promise<{ ok: boolean; status: number; data: unknown }>
}
