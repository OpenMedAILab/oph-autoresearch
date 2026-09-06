import type { LabelSetReference } from './labelset.ts'
export const RESEARCH_STAGES = [
  'question',
  'data_audit',
  'protocol',
  'execution',
  'review',
  'output',
] as const

export type ResearchStage = (typeof RESEARCH_STAGES)[number]

export type ResearchJsonValue =
  | string
  | number
  | boolean
  | null
  | ResearchJsonValue[]
  | { [key: string]: ResearchJsonValue }

export type ResearchJsonObject = { [key: string]: ResearchJsonValue }

export const SYNTHETIC_SUMMARY_TEMPLATE = 'synthetic-summary-v1'
export const SYNTHETIC_EVALUATION_TEMPLATE = 'synthetic-evaluation-v1'
export const SYNTHETIC_TRAINING_TEMPLATE = 'synthetic-training-evaluation-v1'
export const SYNTHETIC_RETINAL_TEMPLATE = 'synthetic-retinal-image-v1'
export const SUPERVISED_PHANTOM_TEMPLATE = 'supervised-phantom-v2'
export type ResearchTemplateId =
  | typeof SYNTHETIC_SUMMARY_TEMPLATE
  | typeof SYNTHETIC_EVALUATION_TEMPLATE
  | typeof SYNTHETIC_TRAINING_TEMPLATE
  | typeof SYNTHETIC_RETINAL_TEMPLATE
  | typeof SUPERVISED_PHANTOM_TEMPLATE
export function isResearchTemplateId(value: unknown): value is ResearchTemplateId {
  return (
    value === SYNTHETIC_SUMMARY_TEMPLATE ||
    value === SYNTHETIC_EVALUATION_TEMPLATE ||
    value === SYNTHETIC_RETINAL_TEMPLATE ||
    value === SUPERVISED_PHANTOM_TEMPLATE ||
    value === SYNTHETIC_TRAINING_TEMPLATE
  )
}
export type ResearchExecutionStage =
  | 'question'
  | 'literature'
  | 'dataset_audit'
  | 'protocol_freeze'
  | 'smoke'
  | 'experiment'
  | 'evaluation'
  | 'independent_review'
  | 'release'

export const RESEARCH_STATUSES = [
  'proposal',
  'active',
  'paused',
  'blocked',
  'completed',
  'cancelled',
] as const

export type ResearchStatus = (typeof RESEARCH_STATUSES)[number]

export interface ResearchBudget {
  currency: string
  limit: number
}

export interface ArtifactVersion {
  mediaType?: string
  dataClass?: 'synthetic' | 'public' | 'restricted-reference'
  inputArtifactVersionIds?: string[]
  schemaId?: string
  validation?: SyntheticCompletionValidation
  producerAttemptId?: string
  producerTaskRevisionId?: string
  id: string
  artifactId: string
  version: number
  uri: string
  kind: string
  contentHash: string
  createdAt: number
}

/** A reviewer proof is admitted only from a trusted internal identity boundary. */
export interface TrustedHumanReviewerProof {
  issuer?: string
  reviewerId: string
  proofId: string
  verifiedAt: number
}

export type ApprovalStatus = 'active' | 'revoked' | 'invalidated'

export interface ResearchApprovalScope {
  display?: { title: string; task: string; revision: number }
  executionLimits?: {
    maxRuntimeMs: number
    cpu: number
    memoryMb: number
    codeHash: string
    inputHash: string
  }
  backendPolicyHash?: string
  trackingPolicyHash?: string
  kind: 'protocol' | 'execution' | 'model_review' | 'release'
  evidencePackHash?: string
  configHash?: string
  maxRequests?: number
  maxOutputTokens?: number
  expiresAt: number
  currency: string
  maxCost: number
  taskRevisionId?: string
  dispatchKey?: string
  artifactVersionIds: string[]
}

export interface HumanApproval {
  scope?: ResearchApprovalScope
  consumedBy?: string

  id: string
  bundleHash: string
  reviewerId: string
  reviewerProofId: string
  reviewedAt: number
  status: ApprovalStatus
  revokedAt: number | null
  revokedByReviewerId: string | null
  invalidatedAt: number | null
}

export type ResearchTaskStatus = 'pending' | 'verified' | 'failed' | 'interrupted' | 'stale'

/** Immutable execution specification. Its status is derived from its attempts. */
export interface ResearchTaskRevision {
  labelSetContentHashes?: string[]
  skillBinding?: {
    id: string
    version: number
    sourceHash: string
    evaluationHash: string
    templateId: string
    templateHash: string
  }
  id: string
  revision: number
  taskId?: string
  previousRevisionId?: string
  sourceContextHash?: string
  artifactVersionIds?: string[]
  stage: 'execution'
  stageId?: ResearchExecutionStage
  templateId: ResearchTemplateId
  inputHash: string
  outputContract: ResearchTemplateId
  dataClass: 'synthetic'
  status: ResearchTaskStatus
  createdAt: number
}

export type ResearchAttemptStatus =
  | 'unknown'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ResearchJobSpec {
  backendPolicyHash?: string
  trackingPolicyHash?: string
  version: 1 | 2
  execution?: {
    adapter: 'supervised-phantom-v2'
    codeHash: string
    maxRuntimeMs: number
  }
  dispatchKey: string
  campaignId: string
  taskRevisionId: string
  templateId: ResearchTemplateId
  inputHash: string
  resource: { cpu: 1; memoryMb: number }
  lease: { ownerId: string; token: string; fence: number; expiresAt: number }
}

export interface ResearchAttempt {
  backendPolicyHash?: string
  trackingPolicyHash?: string
  backend?: 'builtin-local' | 'localhost-daemon' | 'ssh-daemon'
  jobSpec?: ResearchJobSpec
  jobSpecHash?: string
  id: string
  taskRevisionId: string
  dispatchKey: string
  ownerPid: number
  status: ResearchAttemptStatus
  executionStartedAt: number
  endedAt: number | null
  artifactVersionId: string | null
  error: string | null
  cancelRequestedAt: number | null
}

export interface SyntheticCompletionValidation {
  inputHash: string
  contentHash: string
  byteLength: number
  verifiedAt: number
}

export interface ResearchModelReview {
  executionBackend?: 'builtin-session' | 'builtin-cli'
  /** Derived against current evidence; execution status remains historical. */
  sourceValidity?: 'current' | 'stale'
  sourceContextHash?: string
  id: string
  dispatchKey: string
  approvalId: string
  evidencePackHash: string
  configHash: string
  artifactVersionIds: string[]
  currency: string
  reservedCost: number
  maxRequests: number
  maxOutputTokens: number
  requestCount: number
  status: 'reserved' | 'running' | 'done' | 'failed' | 'unknown'
  ownerPid: number
  runId?: string
  conversationId?: string
  text?: string
  contentHash?: string
  actualCost?: number | null
}

export interface ResearchLiteratureCitation {
  id: string
  doi?: string
  pmid?: string
  url: string
  title: string
  publishedAt: string | null
  sourceKind: 'public-metadata'
  retrievedAt: number
  contentHash: string
  locator: { schema: 'crossref-work-v1' | 'pubmed-summary-v1'; pointer: string; endpoint: string }
  projectionHash: string
  verification: 'retrieved-public-metadata'
  fullText: false
}

export interface ResearchCampaign {
  pattern?: { contractHash: string; plan: ResearchJsonObject; taskRevisionIds: string[] }
  patternHistory?: Array<{
    contractHash: string
    plan: ResearchJsonObject
    taskRevisionIds: string[]
  }>
  literatureCitations?: ResearchLiteratureCitation[]
  modelReviews?: ResearchModelReview[]
  labelSets?: LabelSetReference[]
  id: string
  workspaceId: string
  parentConversationId: string
  goal: string
  stage: ResearchStage
  status: ResearchStatus
  version: number
  policy: ResearchJsonObject
  inputs: ResearchJsonObject
  budget: ResearchBudget
  artifactVersions: ArtifactVersion[]
  approvals: HumanApproval[]
  taskRevisions: ResearchTaskRevision[]
  attempts: ResearchAttempt[]
  bundleHash: string
  createdAt: number
  updatedAt: number
}

export type ResearchCommand =
  | {
      kind: 'applyResearchPattern'
      contractHash: string
      plan: ResearchJsonObject
      tasks: Extract<ResearchCommand, { kind: 'declareSyntheticTask' }>[]
    }
  | { kind: 'setPolicy'; policy: ResearchJsonObject }
  | { kind: 'setInputs'; inputs: ResearchJsonObject }
  | { kind: 'setBudget'; budget: ResearchBudget }
  | {
      kind: 'recordArtifact'
      artifactId: string
      uri: string
      artifactKind: string
      contentHash: string
    }
  | {
      kind: 'approve'
      scope?: ResearchApprovalScope
      bundleHash: string
      approvalId?: string
      reviewer: TrustedHumanReviewerProof
    }
  | {
      kind: 'reserveModelReview'
      spec: Omit<ResearchModelReview, 'id' | 'ownerPid' | 'requestCount' | 'status'>
    }
  | { kind: 'startModelReviewRequest'; reviewId: string }
  | {
      kind: 'finishModelReview'
      reviewId: string
      runId: string
      conversationId: string
      text: string
      status: 'done' | 'failed' | 'unknown'
      actualCost: number | null
    }
  | { kind: 'recordLiteratureCitation'; citation: ResearchLiteratureCitation }
  | { kind: 'recordLabelSet'; reference: LabelSetReference; reviewer: TrustedHumanReviewerProof }
  | { kind: 'release'; approvalId: string; artifactVersionIds: string[] }
  | { kind: 'revokeApproval'; approvalId: string; reviewer: TrustedHumanReviewerProof }
  | {
      kind: 'declareSyntheticTask'
      labelSetContentHashes?: string[]
      templateId?: ResearchTemplateId
      skillBinding?: ResearchTaskRevision['skillBinding']
      taskId: string
      inputHash: string
      artifactVersionIds: string[]
      previousRevisionId?: string
    }
  | {
      kind: 'claimSynthetic'
      backendPolicyHash?: string
      trackingPolicyHash?: string
      backend?: 'builtin-local' | 'localhost-daemon' | 'ssh-daemon'
      approvalId?: string
      requireApproval?: boolean
      templateId?: ResearchTemplateId
      dispatchKey: string
      inputHash: string
      taskRevisionId?: string
      skillBinding?: ResearchTaskRevision['skillBinding']
    }
  | {
      kind: 'finishSynthetic'
      attemptId: string
      contentHash: string
      uri: string
      artifactKind: string
      validation: SyntheticCompletionValidation
    }
  | { kind: 'bindSyntheticJob'; attemptId: string; spec: ResearchJobSpec }
  | { kind: 'markSyntheticUnknown'; attemptId: string; reason: string }
  | { kind: 'resumeSyntheticObservation'; attemptId: string; jobSpecHash: string }
  | { kind: 'failSynthetic'; attemptId: string; error: string }
  | { kind: 'requestCancelSynthetic'; attemptId: string }
  | { kind: 'interruptSynthetic'; attemptId: string; reason: string }
  | { kind: 'recoverSynthetic'; attemptId: string; reason: string }

export interface ResearchEvent {
  id: string
  campaignId: string
  sequence: number
  type: 'created' | ResearchCommand['kind']
  command: ResearchCommand | null
  campaign: ResearchCampaign
  occurredAt: number
}

export interface ResearchCampaignInput {
  idempotencyKey: string
  workspaceId: string
  parentConversationId: string
  goal: string
  policy: ResearchJsonObject
  inputs: ResearchJsonObject
  budget: ResearchBudget
}

export type ResearchWriteResult =
  | { ok: true; campaign: ResearchCampaign; event: ResearchEvent; replayed: boolean }
  | { ok: false; code: string; message: string }

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    )
  }
  return value
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The exact bytes whose digest binds a human approval to research inputs and outputs. */
export function canonicalResearchBundle(campaign: ResearchCampaign): string {
  const taskRevisions = Array.isArray(campaign.taskRevisions) ? campaign.taskRevisions : []
  return JSON.stringify(
    canonicalValue({
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      parentConversationId: campaign.parentConversationId,
      goal: campaign.goal,
      ...(campaign.pattern ? { pattern: campaign.pattern } : {}),
      ...(campaign.patternHistory ? { patternHistory: campaign.patternHistory } : {}),
      ...(campaign.literatureCitations === undefined
        ? {}
        : { literatureCitations: campaign.literatureCitations }),
      ...((campaign.modelReviews ?? []).some((r) =>
        ['done', 'failed', 'unknown'].includes(r.status),
      )
        ? {
            modelReviews: campaign
              .modelReviews!.filter((r) => ['done', 'failed', 'unknown'].includes(r.status))
              .map(({ sourceValidity: _derived, ...review }) => review),
          }
        : {}),
      ...(campaign.labelSets === undefined ? {} : { labelSets: campaign.labelSets }),
      stage: campaign.stage,
      policy: campaign.policy,
      inputs: campaign.inputs,
      budget: campaign.budget,
      ...(taskRevisions.length
        ? {
            taskRevisions: taskRevisions
              .map(
                ({
                  id,
                  revision,
                  stage,
                  templateId,
                  inputHash,
                  outputContract,
                  dataClass,
                  taskId,
                  previousRevisionId,
                  sourceContextHash,
                  artifactVersionIds,
                  skillBinding,
                  stageId,
                  labelSetContentHashes,
                }) => ({
                  id,
                  revision,
                  stage,
                  templateId,
                  inputHash,
                  outputContract,
                  dataClass,
                  ...(taskId === undefined ? {} : { taskId }),
                  ...(previousRevisionId === undefined ? {} : { previousRevisionId }),
                  ...(sourceContextHash === undefined ? {} : { sourceContextHash }),
                  ...(artifactVersionIds === undefined ? {} : { artifactVersionIds }),
                  ...(skillBinding === undefined ? {} : { skillBinding }),
                  ...(labelSetContentHashes === undefined ? {} : { labelSetContentHashes }),
                  ...(stageId === undefined ? {} : { stageId }),
                }),
              )
              .sort((left, right) => compareCodeUnits(left.id, right.id)),
          }
        : {}),
      artifactVersions: campaign.artifactVersions
        .map(
          ({
            artifactId,
            version,
            uri,
            kind,
            contentHash,
            producerAttemptId,
            producerTaskRevisionId,
            mediaType,
            dataClass,
            inputArtifactVersionIds,
            schemaId,
            validation,
          }) => ({
            artifactId,
            version,
            uri,
            kind,
            contentHash,
            ...(mediaType === undefined ? {} : { mediaType }),
            ...(dataClass === undefined ? {} : { dataClass }),
            ...(inputArtifactVersionIds === undefined ? {} : { inputArtifactVersionIds }),
            ...(schemaId === undefined ? {} : { schemaId }),
            ...(validation === undefined ? {} : { validation }),
            ...(producerAttemptId === undefined ? {} : { producerAttemptId }),
            ...(producerTaskRevisionId === undefined ? {} : { producerTaskRevisionId }),
          }),
        )
        .sort(
          (left, right) =>
            compareCodeUnits(left.artifactId, right.artifactId) || left.version - right.version,
        ),
    }),
  )
}

/** Replays the campaign snapshot ledger and rejects broken event/version ordering. */
export function foldResearchEvents(events: readonly ResearchEvent[]): ResearchCampaign | null {
  if (events.length === 0) return null
  if (events[0]?.type !== 'created' || events[0]?.command !== null) {
    throw new Error('research campaign ledger must begin with a created event')
  }
  let campaign: ResearchCampaign | null = null
  for (const [index, event] of events.entries()) {
    const expected = index + 1
    if (event.sequence !== expected || event.campaign.version !== expected) {
      throw new Error(`research campaign ${event.campaignId} has a broken event sequence`)
    }
    if (event.campaignId !== event.campaign.id || (campaign && event.campaign.id !== campaign.id)) {
      throw new Error(`research event ${event.id} belongs to a different campaign`)
    }
    campaign = event.campaign
  }
  return campaign
}
