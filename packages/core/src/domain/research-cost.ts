export interface ResearchCostSubject {
  kind: 'cli_preparation' | 'model_review'
  id: string
}
export interface ResearchCostEvidence {
  id: string
  subject: ResearchCostSubject
  currency: string
  amount: number
  sourceHash: string
  source: 'human-attestation' | 'provider-receipt'
  recordedAt: number
}
export interface ResearchCostSettlement {
  id: string
  subject: ResearchCostSubject
  evidenceId: string
  approvalId: string
  currency: string
  amount: number
  settledAt: number
}
