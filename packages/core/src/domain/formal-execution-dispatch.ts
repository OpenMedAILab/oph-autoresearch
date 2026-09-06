import type { FormalExecutionPlan } from './formal-execution.ts'

export type FormalExecutionDispatchState =
  | 'not_sent'
  | 'sending'
  | 'acknowledged'
  | 'observation_unknown'

export interface FormalExecutionObserverLease {
  instanceId: string
  generation: number
  expiresAt: number
}

/** Immutable v4 daemon contract persisted before any transport call. */
export interface FormalExecutionJobSpec {
  version: 4
  dispatchKey: string
  campaignId: string
  taskRevisionId: string
  formalPlan: FormalExecutionPlan
  formalPlanHash: string
  lease: { ownerId: string; token: string; fence: number; expiresAt: number }
  execution: {
    adapter: 'formal-rootless-oci-v1'
    /** Keeps legacy execution narrowing source-compatible; always absent on v4. */
    codeHash?: undefined
    containerName: string
    authorityEpoch: string
  }
}

export interface FormalExecutionAuthorityBinding {
  schema: 'formal-execution-authority-binding-v1'
  routeId: string
  profileId: string
  workspaceBindingHash: string
  connectionHash: string
  remoteRoot: string
  authorityId: string
  admissionEvidenceHash: string
  epoch: string
  jobSpecHash: string
  dispatchState: FormalExecutionDispatchState
  observer?: FormalExecutionObserverLease
}

export interface FormalExecutionDispatch {
  id: string
  planId: string
  planHash: string
  attemptId: string | null
  approvalId: string
  routeId: string
  profileId: string
  workspaceBindingHash: string
  connectionHash: string
  remoteRoot: string
  authorityId: string
  admissionEvidenceHash: string
  reservedMaxCost: number
  status: 'reserved' | 'bound' | 'completed' | 'failed' | 'unknown' | 'cancelled'
  receiptHash?: string
}
