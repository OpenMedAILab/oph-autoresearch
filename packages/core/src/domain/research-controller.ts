export interface ResearchControllerLimits {
  maxAdvances: number
  maxModelRequests: number
  maxOutputTokens: number
  maxInputCharacters: number
  deadlineAt: number
  stopAfter: 'candidate' | 'review'
}
export interface ResearchControllerRequest {
  id: string
  startedAt: number
  finishedAt?: number
  status: 'sending' | 'done' | 'unknown'
  actualCost: number | null
}
export interface ResearchControllerReservation {
  id: string
  approvalId: string
  configHash: string
  sourceContextHash: string
  currency: string
  reservedCost: number
  limits: ResearchControllerLimits
  requests: ResearchControllerRequest[]
  advancesUsed: number
  advanceKeys: string[]
  status: 'active' | 'held' | 'exhausted' | 'completed'
  actualCost: number | null
  createdAt: number
}
