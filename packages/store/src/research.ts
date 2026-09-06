import {
  type ArtifactVersion,
  type CliPreparationObserverIdentity,
  canonicalCliPreparationConfig,
  canonicalFormalExecutionPlan,
  canonicalResearchBundle,
  canonicalResearchControllerBasis,
  foldResearchEvents,
  type HumanApproval,
  isResearchTemplateId,
  parseModelReview,
  type ResearchAttempt,
  type ResearchCampaign,
  type ResearchCampaignInput,
  type ResearchCliPreparation,
  type ResearchCommand,
  type ResearchControllerLimits,
  type ResearchCostSubject,
  type ResearchEvent,
  type ResearchTaskRevision,
  type ResearchWriteResult,
  SYNTHETIC_SUMMARY_TEMPLATE,
  validateLabelSetReference,
  validateLabelSetSuccessor,
  validFormalCodeReviewResult,
  validFormalExecutionPlan,
} from '@oph-autoresearch/core'
import type { Store } from './db.ts'

const SHA256 = /^sha256:[a-f0-9]{64}$/
const AUTHORITY_EPOCH = /^[A-Za-z0-9_-]{16,128}$/
const OBSERVER_LEASE_MAX_MS = 60_000

type EventRow = {
  id: string
  campaign_id: string
  sequence: number
  event_type: ResearchEvent['type']
  command: string | null
  campaign: string
  occurred_at: number
}

type CampaignRow = { snapshot: string }
type IdempotencyRow = { payload_hash: string; result_snapshot: string; event_id: string }

const DEFAULT_PROGRESS_CONTROL = { mode: 'manual', state: 'active', generation: 0 } as const

export interface ResearchRunningAttempt {
  campaignId: string
  taskRevision: ResearchTaskRevision
  attempt: ResearchAttempt
}

export interface RecoverSyntheticAttemptsOptions {
  isOwnerAlive?: (pid: number) => boolean
}

export interface ResearchMutation {
  idempotencyKey: string
  expectedVersion: number
  command: ResearchCommand
}

function digest(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return `sha256:${hasher.digest('hex')}`
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function textError(value: unknown, name: string): string | null {
  return typeof value === 'string' && value.trim() ? null : `${name} 必须是非空字符串`
}

function jsonObject(value: unknown, name: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${name} 必须是 JSON 对象`
  return jsonValue(value) ? null : `${name} 必须是可序列化 JSON`
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(jsonValue)
  )
}

function commandError(command: unknown): string | null {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return 'command 必须是对象'
  }
  return typeof (command as { kind?: unknown }).kind === 'string'
    ? null
    : 'command.kind 必须是字符串'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function budgetError(budget: unknown): string | null {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return 'budget 必须是对象'
  const row = budget as { currency?: unknown; limit?: unknown }
  if (textError(row.currency, 'budget.currency')) return 'budget.currency 必须是非空字符串'
  if (typeof row.limit !== 'number' || !Number.isFinite(row.limit) || row.limit < 0) {
    return 'budget.limit 必须是非负有限数值'
  }
  return null
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function campaignOf(row: CampaignRow | null | undefined): ResearchCampaign | null {
  return row ? normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign) : null
}

function normalizeCampaign(campaign: ResearchCampaign): ResearchCampaign {
  return {
    ...campaign,
    taskRevisions: Array.isArray(campaign.taskRevisions) ? campaign.taskRevisions : [],
    attempts: Array.isArray(campaign.attempts) ? campaign.attempts : [],
  }
}

function progressControl(campaign: ResearchCampaign) {
  return campaign.progressControl ?? DEFAULT_PROGRESS_CONTROL
}

const MAX_CONTROLLER_REQUESTS = 50
const MAX_CONTROLLER_ADVANCES = 50
const MAX_CONTROLLER_OUTPUT_TOKENS = 1_000_000
const MAX_CONTROLLER_INPUT_CHARACTERS = 1_000_000
const MAX_CONTROLLER_DEADLINE_MS = 24 * 60 * 60 * 1000

function validControllerLimits(limits: ResearchControllerLimits | undefined): boolean {
  return Boolean(
    limits &&
      Number.isSafeInteger(limits.maxAdvances) &&
      limits.maxAdvances > 0 &&
      limits.maxAdvances <= MAX_CONTROLLER_ADVANCES &&
      Number.isSafeInteger(limits.maxModelRequests) &&
      limits.maxModelRequests > 0 &&
      limits.maxModelRequests <= MAX_CONTROLLER_REQUESTS &&
      Number.isSafeInteger(limits.maxOutputTokens) &&
      limits.maxOutputTokens > 0 &&
      limits.maxOutputTokens <= MAX_CONTROLLER_OUTPUT_TOKENS &&
      Number.isSafeInteger(limits.maxInputCharacters) &&
      limits.maxInputCharacters > 0 &&
      limits.maxInputCharacters <= MAX_CONTROLLER_INPUT_CHARACTERS &&
      Number.isSafeInteger(limits.deadlineAt) &&
      limits.deadlineAt > 0 &&
      (limits.stopAfter === 'candidate' || limits.stopAfter === 'review'),
  )
}

function validFormalResources(
  resources: import('@oph-autoresearch/core').FormalExecutionResources | undefined,
): boolean {
  return Boolean(
    resources &&
      Number.isSafeInteger(resources.maxRuntimeMs) &&
      resources.maxRuntimeMs > 0 &&
      resources.maxRuntimeMs <= 24 * 60 * 60 * 1000 &&
      Number.isSafeInteger(resources.cpu) &&
      resources.cpu > 0 &&
      resources.cpu <= 256 &&
      Number.isSafeInteger(resources.memoryMb) &&
      resources.memoryMb >= 128 &&
      resources.memoryMb <= 1_048_576 &&
      Number.isSafeInteger(resources.pidsLimit) &&
      resources.pidsLimit >= 1 &&
      resources.pidsLimit <= 65_536 &&
      resources.network === 'disabled',
  )
}

function eventOf(row: EventRow): ResearchEvent {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sequence: row.sequence,
    type: row.event_type,
    command: row.command ? (JSON.parse(row.command) as ResearchCommand) : null,
    campaign: normalizeCampaign(JSON.parse(row.campaign) as ResearchCampaign),
    occurredAt: row.occurred_at,
  }
}

function current(store: Store, id: string): ResearchCampaign | null {
  return campaignOf(
    store.db
      .query<CampaignRow, [string]>('SELECT snapshot FROM research_campaigns WHERE id = ?')
      .get(id),
  )
}

function validInput(input: ResearchCampaignInput): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'campaign input 必须是对象'
  return (
    textError(input.idempotencyKey, 'idempotencyKey') ??
    textError(input.workspaceId, 'workspaceId') ??
    textError(input.parentConversationId, 'parentConversationId') ??
    textError(input.goal, 'goal') ??
    jsonObject(input.policy, 'policy') ??
    jsonObject(input.inputs, 'inputs') ??
    budgetError(input.budget)
  )
}

function invalid(code: string, message: string): ResearchWriteResult {
  return { ok: false, code, message }
}

function bundleHash(campaign: ResearchCampaign): string {
  return digest(canonicalResearchBundle(campaign))
}

/** The exact bytes a formal-review or formal-execution approval signs. */
export function formalExecutionPlanHash(
  plan: import('@oph-autoresearch/core').FormalExecutionPlan,
): string {
  return digest(canonicalFormalExecutionPlan(plan))
}

type CliPreparationConfig = Pick<
  ResearchCliPreparation,
  | 'id'
  | 'taskRevisionId'
  | 'dispatchKey'
  | 'candidateId'
  | 'adapterId'
  | 'adapterConfigHash'
  | 'backendPolicyHash'
  | 'model'
  | 'instructions'
  | 'inputHash'
  | 'deviceId'
  | 'maxRuntimeMs'
  | 'maxCost'
  | 'acknowledgeUnknownCost'
>

function cliPreparationConfigHash(command: CliPreparationConfig) {
  return digest(
    canonicalCliPreparationConfig({
      preparationId: command.id,
      taskRevisionId: command.taskRevisionId,
      dispatchKey: command.dispatchKey,
      candidateId: command.candidateId,
      adapterId: command.adapterId,
      adapterConfigHash: command.adapterConfigHash,
      backendPolicyHash: command.backendPolicyHash,
      model: command.model,
      instructions: command.instructions,
      inputHash: command.inputHash,
      deviceId: command.deviceId,
      maxRuntimeMs: command.maxRuntimeMs,
      maxCost: command.maxCost,
      acknowledgeUnknownCost: command.acknowledgeUnknownCost,
    }),
  )
}

function invalidateChangedApprovals(campaign: ResearchCampaign, now: number): ResearchCampaign {
  return {
    ...campaign,
    approvals: campaign.approvals.map((approval) =>
      approval.status === 'active' && approval.bundleHash !== campaign.bundleHash
        ? { ...approval, status: 'invalidated', invalidatedAt: now }
        : approval,
    ),
  }
}

function costSubjectKey(subject: ResearchCostSubject): string {
  return `${subject.kind}:${subject.id}`
}

function reservationForSubject(
  campaign: ResearchCampaign,
  subject: ResearchCostSubject,
): number | null {
  if (subject.kind === 'cli_preparation') {
    const preparation = (campaign.cliPreparations ?? []).find((item) => item.id === subject.id)
    return preparation && (preparation.status === 'claimed' || preparation.status === 'candidate')
      ? preparation.maxCost
      : null
  }
  if (subject.kind === 'controller') {
    return (
      (campaign.controllerReservations ?? []).find((item) => item.id === subject.id)
        ?.reservedCost ?? null
    )
  }
  if (subject.kind === 'formal_review') {
    return (
      (campaign.formalReviewDispatches ?? []).find((item) => item.id === subject.id)
        ?.reservedCost ?? null
    )
  }
  if (subject.kind === 'formal_execution') {
    return (
      (campaign.formalExecutionDispatches ?? []).find((item) => item.id === subject.id)
        ?.reservedMaxCost ?? null
    )
  }
  const review = (campaign.modelReviews ?? []).find((item) => item.id === subject.id)
  return review ? review.reservedCost : null
}

function knownActualCost(campaign: ResearchCampaign, subject: ResearchCostSubject): number | null {
  const amounts: number[] = []
  const review =
    subject.kind === 'model_review'
      ? (campaign.modelReviews ?? []).find((item) => item.id === subject.id)
      : undefined
  const formalReview =
    subject.kind === 'formal_review'
      ? (campaign.formalReviewDispatches ?? []).find((item) => item.id === subject.id)
      : undefined
  const controller =
    subject.kind === 'controller'
      ? (campaign.controllerReservations ?? []).find((item) => item.id === subject.id)
      : undefined
  if (review?.actualCost !== null && review?.actualCost !== undefined)
    amounts.push(review.actualCost)
  if (formalReview?.actualCost !== null && formalReview?.actualCost !== undefined)
    amounts.push(formalReview.actualCost)
  if (controller?.actualCost !== null && controller?.actualCost !== undefined)
    amounts.push(controller.actualCost)
  // A controller may know individual request charges before every request has a charge.
  // Keep those known charges committed even while its aggregate remains deliberately unknown.
  if (controller?.actualCost === null) {
    const partial = controller.requests
      .map((request) => request.actualCost)
      .filter((amount): amount is number => amount !== null && amount !== undefined)
    if (partial.length > 0) amounts.push(saturatedCostSum(partial))
  }
  for (const evidence of campaign.costEvidence ?? []) {
    if (
      costSubjectKey(evidence.subject) === costSubjectKey(subject) &&
      (evidence.source === 'provider-receipt' ||
        campaign.costSettlements?.some((settlement) => settlement.evidenceId === evidence.id))
    )
      amounts.push(evidence.amount)
  }
  return amounts.length === 0 ? null : Math.max(...amounts)
}

function knownActualSource(
  campaign: ResearchCampaign,
  subject: ResearchCostSubject,
): 'provider-receipt' | 'human-attestation' | 'review-reported' | null {
  const amount = knownActualCost(campaign, subject)
  if (amount === null) return null
  const evidence = (campaign.costEvidence ?? []).find(
    (item) =>
      costSubjectKey(item.subject) === costSubjectKey(subject) &&
      item.amount === amount &&
      (item.source === 'provider-receipt' ||
        campaign.costSettlements?.some((settlement) => settlement.evidenceId === item.id)),
  )
  if (evidence) return evidence.source
  return subject.kind === 'model_review' || subject.kind === 'formal_review'
    ? 'review-reported'
    : null
}

function saturatedCostSum(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || total > Number.MAX_VALUE - value)
      return Number.MAX_VALUE
    total += value
  }
  return total
}

/** Settled spend plus the conservative outstanding cost for each un-settled subject. */
function committedCost(campaign: ResearchCampaign): number {
  const settled = campaign.costSettlements ?? []
  const subjects: ResearchCostSubject[] = [
    ...(campaign.cliPreparations ?? [])
      .filter(
        (preparation) => preparation.status === 'claimed' || preparation.status === 'candidate',
      )
      .map((preparation) => ({ kind: 'cli_preparation' as const, id: preparation.id })),
    ...(campaign.modelReviews ?? []).map((review) => ({
      kind: 'model_review' as const,
      id: review.id,
    })),
    ...(campaign.formalReviewDispatches ?? []).map((review) => ({
      kind: 'formal_review' as const,
      id: review.id,
    })),
    ...(campaign.formalExecutionDispatches ?? []).map((dispatch) => ({
      kind: 'formal_execution' as const,
      id: dispatch.id,
    })),
    ...(campaign.controllerReservations ?? []).map((reservation) => ({
      kind: 'controller' as const,
      id: reservation.id,
    })),
    ...settled.map((settlement) => settlement.subject),
  ]
  const unique = [
    ...new Map(subjects.map((subject) => [costSubjectKey(subject), subject])).values(),
  ]
  return saturatedCostSum(
    unique.map((subject) => {
      const settlement = settled.find(
        (item) => costSubjectKey(item.subject) === costSubjectKey(subject),
      )
      const known = knownActualCost(campaign, subject) ?? 0
      return settlement
        ? Math.max(settlement.amount, known)
        : Math.max(reservationForSubject(campaign, subject) ?? 0, known)
    }),
  )
}

function hasCostCommitment(campaign: ResearchCampaign): boolean {
  return (
    committedCost(campaign) > 0 ||
    (campaign.costEvidence ?? []).length > 0 ||
    (campaign.costSettlements ?? []).length > 0
  )
}

export function researchCostSummary(campaign: ResearchCampaign) {
  const settlements = campaign.costSettlements ?? []
  const subjects: ResearchCostSubject[] = [
    ...(campaign.cliPreparations ?? [])
      .filter(
        (preparation) => preparation.status === 'claimed' || preparation.status === 'candidate',
      )
      .map((preparation) => ({ kind: 'cli_preparation' as const, id: preparation.id })),
    ...(campaign.modelReviews ?? []).map((review) => ({
      kind: 'model_review' as const,
      id: review.id,
    })),
    ...(campaign.formalReviewDispatches ?? []).map((review) => ({
      kind: 'formal_review' as const,
      id: review.id,
    })),
    ...(campaign.formalExecutionDispatches ?? []).map((dispatch) => ({
      kind: 'formal_execution' as const,
      id: dispatch.id,
    })),
    ...(campaign.controllerReservations ?? []).map((reservation) => ({
      kind: 'controller' as const,
      id: reservation.id,
    })),
  ]
  const rows = subjects.map((subject) => {
    const settlement = settlements.find(
      (item) => costSubjectKey(item.subject) === costSubjectKey(subject),
    )
    return {
      subject,
      reservation: reservationForSubject(campaign, subject) ?? 0,
      knownActualCost: knownActualCost(campaign, subject),
      knownActualSource: knownActualSource(campaign, subject),
      settled: settlement !== undefined,
      settledAmount: settlement?.amount ?? null,
    }
  })
  const settledCost = saturatedCostSum(settlements.map((settlement) => settlement.amount))
  const reservedCost = rows
    .filter((row) => !row.settled)
    .reduce((sum, row) => saturatedCostSum([sum, row.reservation]), 0)
  const committed = committedCost(campaign)
  return {
    currency: campaign.budget.currency,
    limit: campaign.budget.limit,
    settledCost,
    reservedCost,
    committedCost: committed,
    availableCost: Math.max(0, campaign.budget.limit - committed),
    overLimit: committed > campaign.budget.limit,
    subjects: rows,
  }
}

function validCostSubject(
  campaign: ResearchCampaign,
  subject: unknown,
): subject is ResearchCostSubject {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return false
  const value = subject as { kind?: unknown; id?: unknown }
  if (
    (value.kind !== 'cli_preparation' &&
      value.kind !== 'model_review' &&
      value.kind !== 'formal_review' &&
      value.kind !== 'formal_execution' &&
      value.kind !== 'controller') ||
    typeof value.id !== 'string' ||
    value.id !== value.id.trim() ||
    textError(value.id, 'cost subject id')
  )
    return false
  return reservationForSubject(campaign, { kind: value.kind, id: value.id.trim() }) !== null
}

function costSubjectLabel(campaign: ResearchCampaign, subject: ResearchCostSubject): string | null {
  const entries =
    subject.kind === 'cli_preparation'
      ? (campaign.cliPreparations ?? [])
      : subject.kind === 'model_review'
        ? (campaign.modelReviews ?? [])
        : subject.kind === 'formal_review'
          ? (campaign.formalReviewDispatches ?? [])
          : subject.kind === 'formal_execution'
            ? (campaign.formalExecutionDispatches ?? [])
            : (campaign.controllerReservations ?? [])
  const index = entries.findIndex((entry) => entry.id === subject.id)
  if (index < 0) return null
  return `第 ${index + 1} 次${
    subject.kind === 'cli_preparation'
      ? '代码准备'
      : subject.kind === 'model_review'
        ? '独立复核'
        : subject.kind === 'formal_review'
          ? '正式代码审阅'
          : subject.kind === 'formal_execution'
            ? '正式执行'
            : '有界主控'
  }`
}

function subjectExecutionIsTerminal(
  campaign: ResearchCampaign,
  subject: ResearchCostSubject,
): boolean {
  if (subject.kind === 'cli_preparation') {
    const preparation = (campaign.cliPreparations ?? []).find((item) => item.id === subject.id)
    const attempt = campaign.attempts.find((item) => item.id === preparation?.attemptId)
    return Boolean(
      attempt && ['completed', 'failed', 'cancelled', 'interrupted'].includes(attempt.status),
    )
  }
  if (subject.kind === 'controller') {
    const reservation = (campaign.controllerReservations ?? []).find(
      (item) => item.id === subject.id,
    )
    return Boolean(
      reservation &&
        ['completed', 'exhausted'].includes(reservation.status) &&
        reservation.requests.every((request) => request.status === 'done'),
    )
  }
  if (subject.kind === 'formal_review') {
    const dispatch = (campaign.formalReviewDispatches ?? []).find((item) => item.id === subject.id)
    return Boolean(dispatch && ['done', 'failed', 'unknown'].includes(dispatch.status))
  }
  if (subject.kind === 'formal_execution') {
    const dispatch = (campaign.formalExecutionDispatches ?? []).find(
      (item) => item.id === subject.id,
    )
    return Boolean(
      dispatch && ['completed', 'failed', 'unknown', 'cancelled'].includes(dispatch.status),
    )
  }
  const review = (campaign.modelReviews ?? []).find((item) => item.id === subject.id)
  return Boolean(
    review &&
      (review.executionOutcome === 'completed' ||
        review.executionOutcome === 'failed' ||
        (!review.executionOutcome && (review.status === 'done' || review.status === 'failed'))),
  )
}

export function costEvidenceApprovalScope(
  campaign: ResearchCampaign,
  evidenceId: string,
  expiresAt: number,
) {
  const evidence = (campaign.costEvidence ?? []).find((item) => item.id === evidenceId)
  if (!evidence) throw new Error('Unknown cost evidence')
  if (!subjectExecutionIsTerminal(campaign, evidence.subject))
    throw new Error('Cost evidence subject is not terminal')
  const label = costSubjectLabel(campaign, evidence.subject)
  if (!label) throw new Error('Unknown cost evidence subject')
  return {
    kind: 'cost_settlement' as const,
    costEvidenceId: evidence.id,
    costEvidenceHash: digest(canonicalJson(evidence)),
    costSubjectLabel: label,
    costDescription: evidence.description,
    costSubject: cloneJson(evidence.subject),
    costAmount: evidence.amount,
    artifactVersionIds: [],
    currency: evidence.currency,
    maxCost: evidence.amount,
    costResearchTitle: campaign.goal,
    expiresAt,
  }
}

export function controllerApprovalScope(
  campaign: ResearchCampaign,
  input: {
    configHash: string
    reservedCost: number
    limits: ResearchControllerLimits
    expiresAt: number
  },
) {
  return {
    kind: 'controller' as const,
    configHash: input.configHash,
    controllerLimits: cloneJson(input.limits),
    artifactVersionIds: [],
    currency: campaign.budget.currency,
    maxCost: input.reservedCost,
    expiresAt: input.expiresAt,
  }
}

export function canStartControllerRequest(
  campaign: ResearchCampaign,
  reservationId: string,
  generation: number,
  now = Date.now(),
): boolean {
  const control = progressControl(campaign)
  const reservation = (campaign.controllerReservations ?? []).find(
    (item) => item.id === reservationId,
  )
  const approval = campaign.approvals.find((item) => item.id === reservation?.approvalId)
  return Boolean(
    reservation &&
      reservation.status === 'active' &&
      approval !== undefined &&
      approval.status !== 'revoked' &&
      approval.consumedBy === `controller:${reservation.id}` &&
      reservation.sourceContextHash === scientificContextHash(campaign, 2) &&
      control.mode === 'bounded' &&
      control.state === 'active' &&
      control.reservationRef === reservation.id &&
      control.generation === generation &&
      reservation.limits.deadlineAt > now &&
      reservation.requests.length < reservation.limits.maxModelRequests &&
      !reservation.requests.some(
        (request) => request.status === 'sending' || request.status === 'unknown',
      ) &&
      !campaign.attempts.some((attempt) => attempt.status === 'unknown') &&
      committedCost(campaign) <= campaign.budget.limit &&
      !controllerStopReached(campaign, reservation.limits.stopAfter),
  )
}

function canReserveControllerAdvance(
  campaign: ResearchCampaign,
  reservationId: string,
  generation: number,
  now: number,
): boolean {
  const control = progressControl(campaign)
  const reservation = (campaign.controllerReservations ?? []).find(
    (item) => item.id === reservationId,
  )
  const approval = campaign.approvals.find((item) => item.id === reservation?.approvalId)
  return Boolean(
    reservation &&
      reservation.status === 'active' &&
      approval !== undefined &&
      approval.status !== 'revoked' &&
      approval.consumedBy === `controller:${reservation.id}` &&
      reservation.sourceContextHash === scientificContextHash(campaign, 2) &&
      control.mode === 'bounded' &&
      control.state === 'active' &&
      control.reservationRef === reservation.id &&
      control.generation === generation &&
      reservation.limits.deadlineAt > now &&
      reservation.advancesUsed < reservation.limits.maxAdvances &&
      !reservation.requests.some((request) => request.status === 'unknown') &&
      !campaign.attempts.some((attempt) => attempt.status === 'unknown') &&
      committedCost(campaign) <= campaign.budget.limit &&
      !controllerStopReached(campaign, reservation.limits.stopAfter),
  )
}

function controllerStopReached(
  campaign: ResearchCampaign,
  stopAfter: ResearchControllerLimits['stopAfter'],
): boolean {
  if (stopAfter === 'candidate')
    return (campaign.cliPreparations ?? []).some(
      (preparation) => preparation.status === 'candidate',
    )
  const releasable = campaign.artifactVersions
    .filter((artifact) => hasExactReleasableArtifact(campaign, artifact.id))
    .map((artifact) => artifact.id)
  return releasable.some((artifactId) => hasSupportedReleaseReview(campaign, [artifactId]))
}

function controllerReservationIsResolved(
  campaign: ResearchCampaign,
  reservationId: string,
): boolean {
  const reservation = (campaign.controllerReservations ?? []).find(
    (item) => item.id === reservationId,
  )
  return Boolean(
    reservation &&
      ['completed', 'exhausted'].includes(reservation.status) &&
      reservation.requests.every((request) => request.status === 'done'),
  )
}

function validateProof(proof: {
  reviewerId: string
  proofId: string
  verifiedAt: number
}): string | null {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return 'reviewer 必须是对象'
  return (
    textError(proof.reviewerId, 'reviewer.reviewerId') ??
    textError(proof.proofId, 'reviewer.proofId') ??
    (!Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt <= 0
      ? 'reviewer.verifiedAt 必须是正整数时间戳'
      : null)
  )
}

function formalReviewMatchesPlan(
  review: import('@oph-autoresearch/core').FormalCodeReviewResult,
  plan: import('@oph-autoresearch/core').FormalExecutionPlan,
): boolean {
  return (
    review.formalPlanHash === formalExecutionPlanHash(plan) &&
    review.candidateArtifactId === plan.candidateArtifactId &&
    review.taskRevisionId === plan.taskRevisionId &&
    review.codeHash === plan.codeHash &&
    review.candidateReceiptHash === plan.candidateReceiptHash &&
    review.workspaceBindingHash === plan.workspaceBindingHash &&
    review.ociImageDigest === plan.ociImageDigest &&
    review.dataManifestHash === plan.dataManifestHash &&
    review.labelSetContentHash === plan.labelSetContentHash &&
    review.trustedEvaluatorId === plan.trustedEvaluatorId &&
    review.trustedEvaluatorHash === plan.trustedEvaluatorHash
  )
}

function taskStatus(
  task: ResearchTaskRevision,
  attempts: readonly ResearchAttempt[],
  cliPreparationAttemptIds: ReadonlySet<string>,
) {
  // A preparation produces an unadmitted candidate, never a verified scientific task result.
  const related = attempts.filter(
    (attempt) => attempt.taskRevisionId === task.id && !cliPreparationAttemptIds.has(attempt.id),
  )
  if (related.some((attempt) => attempt.status === 'completed')) return 'verified' as const
  if (related.some((attempt) => attempt.status === 'running')) return 'pending' as const
  if (related.some((attempt) => attempt.status === 'failed')) return 'failed' as const
  if (
    related.some((attempt) => attempt.status === 'cancelled' || attempt.status === 'interrupted')
  ) {
    return 'interrupted' as const
  }
  return 'pending' as const
}

/** v1 preserves the historical budget-inclusive hash; v2 binds science only. */
export function scientificContextHash(campaign: ResearchCampaign, version: 1 | 2 = 1): string {
  return digest(
    canonicalJson(
      version === 1
        ? { policy: campaign.policy, inputs: campaign.inputs, budget: campaign.budget }
        : {
            schema: 'research-scientific-context-v2',
            goal: campaign.goal,
            policy: campaign.policy,
            inputs: campaign.inputs,
          },
    ),
  )
}

function withDerivedTaskStatuses(campaign: ResearchCampaign): ResearchCampaign {
  const cliPreparationAttemptIds = new Set(
    (campaign.cliPreparations ?? [])
      .map((preparation) => preparation.attemptId)
      .filter((attemptId): attemptId is string => attemptId !== null),
  )
  const stale = new Set<string>()
  for (const task of campaign.taskRevisions) {
    for (const contentHash of task.labelSetContentHashes ?? []) {
      const bound = campaign.labelSets?.find((ref) => ref.contentHash === contentHash)
      const latest = campaign.labelSets
        ?.filter((ref) => ref.id === bound?.id)
        .toSorted((a, b) => b.version - a.version)[0]
      if (!bound || latest?.contentHash !== contentHash) stale.add(task.id)
    }
    if (
      task.sourceContextHash &&
      task.sourceContextHash !== scientificContextHash(campaign, task.sourceContextVersion ?? 1)
    )
      stale.add(task.id)
    if (campaign.taskRevisions.some((next) => next.previousRevisionId === task.id))
      stale.add(task.id)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const task of campaign.taskRevisions) {
      if (stale.has(task.id)) continue
      const invalid = (task.artifactVersionIds ?? []).some((id) => {
        const artifact = campaign.artifactVersions.find((item) => item.id === id)
        if (!artifact) return true
        return (
          campaign.artifactVersions.some(
            (item) => item.artifactId === artifact.artifactId && item.version > artifact.version,
          ) ||
          (artifact.producerTaskRevisionId !== undefined &&
            stale.has(artifact.producerTaskRevisionId))
        )
      })
      if (invalid) {
        stale.add(task.id)
        changed = true
      }
    }
  }
  return {
    ...campaign,
    ...(campaign.modelReviews
      ? {
          modelReviews: campaign.modelReviews.map((review) => ({
            ...review,
            sourceValidity:
              (review.sourceContextHash !== undefined &&
                review.sourceContextHash !==
                  reviewSourceContextHash(campaign, review.sourceContextVersion ?? 1)) ||
              review.artifactVersionIds.some((id) => {
                const artifact = campaign.artifactVersions.find((a) => a.id === id)
                return (
                  !artifact ||
                  !artifact.validation ||
                  !artifact.producerTaskRevisionId ||
                  stale.has(artifact.producerTaskRevisionId) ||
                  campaign.artifactVersions.some(
                    (a) => a.artifactId === artifact.artifactId && a.version > artifact.version,
                  )
                )
              })
                ? ('stale' as const)
                : ('current' as const),
          })),
        }
      : {}),
    taskRevisions: campaign.taskRevisions.map((task) => ({
      ...task,
      status: stale.has(task.id)
        ? 'stale'
        : taskStatus(task, campaign.attempts, cliPreparationAttemptIds),
    })),
  }
}

export function reviewSourceContextHash(campaign: ResearchCampaign, version: 1 | 2 = 1): string {
  return digest(
    canonicalJson({
      context: scientificContextHash(campaign, version),
      literatureCitations: campaign.literatureCitations ?? [],
    }),
  )
}

/** A release may cite only the exact, current artifact versions independently reviewed as supported. */
export function hasSupportedReleaseReview(
  campaign: ResearchCampaign,
  artifactVersionIds: readonly string[],
): boolean {
  const expectedIds = [...artifactVersionIds].sort()
  const derived = withDerivedTaskStatuses(campaign)
  return (derived.modelReviews ?? []).some((review) => {
    if (
      review.status !== 'done' ||
      review.sourceValidity !== 'current' ||
      review.sourceContextHash !==
        reviewSourceContextHash(campaign, review.sourceContextVersion ?? 1) ||
      typeof review.text !== 'string' ||
      review.contentHash !== digest(review.text) ||
      canonicalJson([...review.artifactVersionIds].sort()) !== canonicalJson(expectedIds)
    )
      return false
    try {
      const map = parseModelReview(review.text, review.artifactVersionIds)
      return (
        map.decision === 'supported' &&
        expectedIds.every((artifactVersionId) =>
          map.claims.some((claim) => claim.artifactVersionIds.includes(artifactVersionId)),
        )
      )
    } catch {
      return false
    }
  })
}

function hasExactReleasableArtifact(
  campaign: ResearchCampaign,
  artifactVersionId: string,
): boolean {
  const artifact = campaign.artifactVersions.find((candidate) => candidate.id === artifactVersionId)
  if (
    !artifact ||
    artifact.kind === 'cli_preparation_candidate' ||
    artifact.kind === 'cli_preparation_quarantined_candidate' ||
    !artifact.validation ||
    artifact.contentHash !== artifact.validation.contentHash ||
    !artifact.producerAttemptId ||
    !artifact.producerTaskRevisionId ||
    campaign.artifactVersions.some(
      (candidate) =>
        candidate.artifactId === artifact.artifactId && candidate.version > artifact.version,
    )
  )
    return false
  const task = campaign.taskRevisions.find(
    (candidate) => candidate.id === artifact.producerTaskRevisionId,
  )
  const attempt = campaign.attempts.find((candidate) => candidate.id === artifact.producerAttemptId)
  if (!task || !attempt) return false
  return (
    task.id === artifact.producerTaskRevisionId &&
    artifact.validation.inputHash === task.inputHash &&
    attempt.taskRevisionId === task.id &&
    attempt.status === 'completed' &&
    attempt.artifactVersionId === artifact.id &&
    withDerivedTaskStatuses(campaign).taskRevisions.find((candidate) => candidate.id === task.id)
      ?.status === 'verified'
  )
}

function attemptById(campaign: ResearchCampaign, attemptId: unknown): ResearchAttempt | null {
  if (textError(attemptId, 'attemptId')) return null
  return campaign.attempts.find((attempt) => attempt.id === attemptId) ?? null
}

function ownedRunningAttempt(
  campaign: ResearchCampaign,
  attemptId: unknown,
  observer?: CliPreparationObserverIdentity,
  now = Date.now(),
): { ok: true; attempt: ResearchAttempt } | { ok: false; code: string; message: string } {
  const attempt = attemptById(campaign, attemptId)
  if (!attempt) return { ok: false, code: 'unknown_attempt', message: '找不到 attemptId' }
  const authority = attempt.cliPreparationAuthority
  if (
    authority &&
    (!observer ||
      authority.observer?.instanceId !== observer.instanceId ||
      authority.observer.generation !== observer.generation ||
      authority.observer.expiresAt <= now)
  ) {
    return {
      ok: false,
      code: 'stale_cli_preparation_observer',
      message: 'CLI 准备观察者租约已过期或已由其他实例接管',
    }
  }
  if (!authority && attempt.ownerPid !== process.pid) {
    return {
      ok: false,
      code: 'not_attempt_owner',
      message: '只有领取该尝试的进程可以提交执行结果',
    }
  }
  if (attempt.status !== 'running') {
    return { ok: false, code: 'inactive_attempt', message: '该尝试已结束' }
  }
  return { ok: true, attempt }
}

function validObserverLease(
  command: {
    instanceId: string
    expectedEpoch: string
    expectedJobSpecHash: string
    leaseExpiresAt: number
  },
  now: number,
) {
  return (
    !textError(command.instanceId, 'observer instance') &&
    AUTHORITY_EPOCH.test(command.expectedEpoch) &&
    SHA256.test(command.expectedJobSpecHash) &&
    Number.isSafeInteger(command.leaseExpiresAt) &&
    command.leaseExpiresAt > now &&
    command.leaseExpiresAt <= now + OBSERVER_LEASE_MAX_MS
  )
}

function cliAuthorityMatches(
  attempt: ResearchAttempt,
  expectedEpoch: string,
  expectedJobSpecHash: string,
) {
  const binding = attempt.cliPreparationAuthority
  return Boolean(
    binding &&
      binding.epoch === expectedEpoch &&
      binding.jobSpecHash === expectedJobSpecHash &&
      binding.backendPolicyHash === attempt.backendPolicyHash &&
      binding.jobSpecHash === attempt.cliPreparationJobSpecHash,
  )
}

function currentCliObserver(
  attempt: ResearchAttempt,
  observer: CliPreparationObserverIdentity | undefined,
  now: number,
) {
  const binding = attempt.cliPreparationAuthority
  if (!binding) return true
  return Boolean(
    observer &&
      binding.observer?.instanceId === observer.instanceId &&
      binding.observer.generation === observer.generation &&
      binding.observer.expiresAt > now,
  )
}

function formalAuthorityMatches(
  attempt: ResearchAttempt,
  expectedEpoch: string,
  expectedJobSpecHash: string,
) {
  const binding = attempt.formalExecutionAuthority
  return Boolean(
    binding &&
      binding.epoch === expectedEpoch &&
      binding.jobSpecHash === expectedJobSpecHash &&
      binding.jobSpecHash === attempt.formalExecutionJobSpecHash,
  )
}

function currentFormalObserver(
  attempt: ResearchAttempt,
  observer: { instanceId: string; generation: number } | undefined,
  now: number,
) {
  const binding = attempt.formalExecutionAuthority
  return Boolean(
    binding &&
      observer &&
      binding.observer?.instanceId === observer.instanceId &&
      binding.observer.generation === observer.generation &&
      binding.observer.expiresAt > now,
  )
}

function nextCampaign(
  campaign: ResearchCampaign,
  command: ResearchCommand,
  now: number,
): { ok: true; campaign: ResearchCampaign } | { ok: false; code: string; message: string } {
  let next: ResearchCampaign
  if ('skillBinding' in command && command.skillBinding !== undefined) {
    const binding = command.skillBinding
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      textError(binding.id, 'skill id') ||
      !Number.isSafeInteger(binding.version) ||
      binding.version < 1 ||
      !SHA256.test(binding.sourceHash) ||
      !SHA256.test(binding.evaluationHash) ||
      !SHA256.test(binding.templateHash) ||
      !isResearchTemplateId(binding.templateId) ||
      binding.templateId !== (command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE)
    )
      return invalid('invalid_skill_binding', '执行技能绑定无效')
  }
  switch (command.kind) {
    case 'claimCliPreparationDispatch': {
      const attempt = attemptById(campaign, command.attemptId)
      if (
        !attempt ||
        !validObserverLease(command, now) ||
        !cliAuthorityMatches(attempt, command.expectedEpoch, command.expectedJobSpecHash) ||
        !['running', 'unknown'].includes(attempt.status) ||
        attempt.cliPreparationAuthority?.dispatchState !== 'not_sent'
      )
        return invalid(
          'invalid_cli_preparation_dispatch_claim',
          '首次投递必须绑定当前 authority epoch、作业哈希和短期观察租约',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id
            ? {
                ...candidate,
                cliPreparationAuthority: {
                  ...candidate.cliPreparationAuthority!,
                  dispatchState: 'sending',
                  observer: {
                    instanceId: command.instanceId,
                    generation: 1,
                    expiresAt: command.leaseExpiresAt,
                  },
                },
              }
            : candidate,
        ),
      }
      break
    }
    case 'acquireCliPreparationObservation': {
      const attempt = attemptById(campaign, command.attemptId)
      const binding = attempt?.cliPreparationAuthority
      const prior = binding?.observer
      const renewal = prior?.instanceId === command.instanceId && prior.expiresAt > now
      if (
        !attempt ||
        !binding ||
        !validObserverLease(command, now) ||
        !cliAuthorityMatches(attempt, command.expectedEpoch, command.expectedJobSpecHash) ||
        !['running', 'unknown'].includes(attempt.status) ||
        binding.dispatchState === 'not_sent' ||
        (prior !== undefined && prior.expiresAt > now && !renewal) ||
        (renewal && command.leaseExpiresAt < prior.expiresAt)
      )
        return invalid(
          'invalid_cli_preparation_observer_claim',
          '观察者只能续租自身有效租约，或在租约到期后接管原 authority 作业',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id
            ? {
                ...candidate,
                cliPreparationAuthority: {
                  ...binding,
                  observer: {
                    instanceId: command.instanceId,
                    generation: renewal ? prior.generation : (prior?.generation ?? 0) + 1,
                    expiresAt: command.leaseExpiresAt,
                  },
                },
              }
            : candidate,
        ),
      }
      break
    }
    case 'acknowledgeCliPreparationDispatch':
    case 'markCliPreparationObservationUnknown': {
      const attempt = attemptById(campaign, command.attemptId)
      const binding = attempt?.cliPreparationAuthority
      const observer = binding?.observer
      if (
        !attempt ||
        !binding ||
        !AUTHORITY_EPOCH.test(command.expectedEpoch) ||
        binding.epoch !== command.expectedEpoch ||
        !observer ||
        observer.instanceId !== command.instanceId ||
        observer.generation !== command.generation ||
        observer.expiresAt <= now ||
        (command.kind === 'acknowledgeCliPreparationDispatch' &&
          binding.dispatchState !== 'sending')
      )
        return invalid(
          'stale_cli_preparation_observer',
          '只有当前未过期的观察者可确认投递或记录观察状态',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id
            ? {
                ...candidate,
                cliPreparationAuthority: {
                  ...binding,
                  dispatchState:
                    command.kind === 'acknowledgeCliPreparationDispatch'
                      ? 'acknowledged'
                      : binding.dispatchState === 'sending'
                        ? 'sending'
                        : 'observation_unknown',
                },
              }
            : candidate,
        ),
      }
      break
    }
    case 'setResearchProgress': {
      const control = progressControl(campaign)
      if (
        (command.state !== 'active' && command.state !== 'held') ||
        !Number.isSafeInteger(command.expectedGeneration) ||
        command.expectedGeneration < 0 ||
        command.expectedGeneration !== control.generation
      )
        return invalid(
          'progress_generation_conflict',
          'Manual progress control requires the current generation',
        )
      if (control.mode === 'bounded' && control.state === 'exhausted' && command.state === 'active')
        return invalid('bounded_exhausted', 'An exhausted bounded controller cannot become active')
      const reservation =
        control.mode === 'bounded' && control.reservationRef
          ? (campaign.controllerReservations ?? []).find(
              (item) => item.id === control.reservationRef,
            )
          : undefined
      if (
        control.mode === 'bounded' &&
        command.state === 'active' &&
        (campaign.attempts.some((attempt) => attempt.status === 'unknown') ||
          reservation?.requests.some((request) => request.status === 'unknown'))
      )
        return invalid(
          'controller_unknown_pending',
          'Unknown work must be reconciled before resuming',
        )
      next = {
        ...campaign,
        ...(reservation
          ? {
              controllerReservations: campaign.controllerReservations!.map((item) =>
                item.id === reservation.id
                  ? {
                      ...item,
                      status:
                        command.state === 'held' && item.status === 'active'
                          ? ('held' as const)
                          : command.state === 'active' && item.status === 'held'
                            ? ('active' as const)
                            : item.status,
                    }
                  : item,
              ),
            }
          : {}),
        progressControl: {
          mode: control.mode,
          state: command.state,
          ...('reservationRef' in control && control.reservationRef
            ? { reservationRef: control.reservationRef }
            : {}),
          generation: control.generation + 1,
        },
      }
      break
    }
    case 'claimControllerRound': {
      const reservation = campaign.controllerReservations?.find(
        (item) => item.id === command.reservationId,
      )
      const round = reservation?.round
      if (
        !reservation ||
        !canStartControllerRequest(campaign, command.reservationId, command.generation, now) ||
        textError(command.roundId, 'roundId') ||
        command.basisHash !== digest(canonicalResearchControllerBasis(campaign)) ||
        !Number.isSafeInteger(command.expiresAt) ||
        command.expiresAt <= now ||
        command.expiresAt > now + 60000 ||
        (round && !round.finishedAt && round.expiresAt > now) ||
        (round &&
          round.generation === command.generation &&
          round.basisHash === command.basisHash &&
          (round.finishedAt !== undefined ||
            reservation.requests.length > round.requestCountAtStart))
      )
        return invalid('controller_round_denied', '当前推进轮尚未结束，或研究依据没有变化')
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id
            ? (() => {
                const { waiting: _waiting, ...rest } = item
                return {
                  ...rest,
                  round: {
                    generation: command.generation,
                    id: command.roundId,
                    basisHash: command.basisHash,
                    requestCountAtStart: item.requests.length,
                    expiresAt: command.expiresAt,
                  },
                }
              })()
            : item,
        ),
      }
      break
    }
    case 'renewControllerRound':
    case 'finishControllerRound': {
      const reservation = campaign.controllerReservations?.find(
        (item) => item.id === command.reservationId,
      )
      const round = reservation?.round
      if (
        !reservation ||
        !round ||
        round.id !== command.roundId ||
        round.finishedAt ||
        (command.kind === 'renewControllerRound' &&
          (round.expiresAt <= now ||
            !Number.isSafeInteger(command.expiresAt) ||
            command.expiresAt < round.expiresAt ||
            command.expiresAt > now + 60000))
      )
        return invalid('controller_round_denied', '主控推进轮已失去持有权')
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id
            ? {
                ...item,
                round:
                  command.kind === 'finishControllerRound'
                    ? { ...round, finishedAt: now }
                    : { ...round, expiresAt: command.expiresAt },
              }
            : item,
        ),
      }
      break
    }
    case 'waitController': {
      const reservation = campaign.controllerReservations?.find(
        (item) => item.id === command.reservationId,
      )
      const control = progressControl(campaign)
      if (
        !reservation ||
        control.mode !== 'bounded' ||
        control.state !== 'active' ||
        control.reservationRef !== reservation.id ||
        control.generation !== command.generation ||
        !['remote', 'human', 'change', 'unknown'].includes(command.reason)
      )
        return invalid('controller_wait_denied', '推进状态已变化')
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id ? { ...item, waiting: command.reason } : item,
        ),
      }
      break
    }
    case 'activateBoundedResearch': {
      const control = progressControl(campaign)
      const approval = campaign.approvals.find((item) => item.id === command.approvalId)
      const scope = approval?.scope
      const previousControllerResolved =
        control.mode === 'bounded' &&
        control.state === 'exhausted' &&
        control.reservationRef !== undefined &&
        controllerReservationIsResolved(campaign, control.reservationRef)
      if (
        !(
          (control.mode === 'manual' && control.state === 'active') ||
          previousControllerResolved
        ) ||
        control.generation !== command.expectedGeneration ||
        !validControllerLimits(command.limits) ||
        command.limits.deadlineAt <= now ||
        command.limits.deadlineAt > now + MAX_CONTROLLER_DEADLINE_MS ||
        textError(command.reservationId, 'reservationId') ||
        !SHA256.test(command.configHash) ||
        !Number.isFinite(command.reservedCost) ||
        command.reservedCost <= 0 ||
        command.currency !== campaign.budget.currency ||
        saturatedCostSum([committedCost(campaign), command.reservedCost]) > campaign.budget.limit ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'controller' ||
        !Number.isSafeInteger(scope.expiresAt) ||
        scope.expiresAt <= now ||
        scope.configHash !== command.configHash ||
        scope.currency !== command.currency ||
        scope.maxCost !== command.reservedCost ||
        scope.controllerLimits === undefined ||
        canonicalJson(scope.controllerLimits) !== canonicalJson(command.limits) ||
        (campaign.controllerReservations ?? []).some((item) => item.id === command.reservationId)
      )
        return invalid(
          'controller_approval_required',
          'Bounded controller requires an exact active approval',
        )
      next = {
        ...campaign,
        controllerReservations: [
          ...(campaign.controllerReservations ?? []),
          {
            id: command.reservationId.trim(),
            approvalId: approval.id,
            configHash: command.configHash,
            sourceContextHash: scientificContextHash(campaign, 2),
            currency: command.currency,
            reservedCost: command.reservedCost,
            limits: cloneJson(command.limits),
            requests: [],
            advancesUsed: 0,
            advanceKeys: [],
            status: 'active',
            actualCost: null,
            createdAt: now,
          },
        ],
        progressControl: {
          mode: 'bounded',
          state: 'active',
          reservationRef: command.reservationId.trim(),
          generation: control.generation + 1,
        },
        approvals: campaign.approvals.map((item) =>
          item.id === approval.id
            ? { ...item, consumedBy: `controller:${command.reservationId.trim()}` }
            : item,
        ),
      }
      break
    }
    case 'startControllerRequest': {
      const reservation = (campaign.controllerReservations ?? []).find(
        (item) => item.id === command.reservationId,
      )
      if (
        !reservation ||
        textError(command.requestId, 'requestId') ||
        reservation.requests.some((item) => item.id === command.requestId) ||
        !canStartControllerRequest(campaign, command.reservationId, command.generation, now)
      )
        return invalid('controller_request_denied', 'Bounded controller request is not available')
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id
            ? {
                ...item,
                requests: [
                  ...item.requests,
                  {
                    id: command.requestId.trim(),
                    startedAt: now,
                    status: 'sending',
                    actualCost: null,
                  },
                ],
              }
            : item,
        ),
      }
      break
    }
    case 'finishControllerRequest': {
      const reservation = (campaign.controllerReservations ?? []).find(
        (item) => item.id === command.reservationId,
      )
      const request = reservation?.requests.find((item) => item.id === command.requestId)
      if (
        !reservation ||
        !request ||
        request.status !== 'sending' ||
        (command.actualCost !== null &&
          (!Number.isFinite(command.actualCost) || command.actualCost < 0))
      )
        return invalid('controller_request_denied', 'Only a persisted sending request may finish')
      const requests = reservation.requests.map((item) =>
        item.id === request.id
          ? {
              ...item,
              finishedAt: now,
              status: command.completed ? ('done' as const) : ('unknown' as const),
              actualCost: command.actualCost,
            }
          : item,
      )
      const exhausted =
        requests.length >= reservation.limits.maxModelRequests ||
        now >= reservation.limits.deadlineAt
      const actualCost = requests.every((item) => item.actualCost !== null)
        ? saturatedCostSum(requests.map((item) => item.actualCost!))
        : null
      const control = progressControl(campaign)
      const finishesCurrentReservation =
        control.mode === 'bounded' && control.reservationRef === reservation.id
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id
            ? { ...item, requests, actualCost, status: exhausted ? 'exhausted' : item.status }
            : item,
        ),
        ...(exhausted && finishesCurrentReservation
          ? {
              progressControl: {
                mode: 'bounded' as const,
                state: 'exhausted' as const,
                reservationRef: reservation.id,
                generation: progressControl(campaign).generation + 1,
              },
            }
          : {}),
      }
      break
    }
    case 'reserveControllerAdvance': {
      const reservation = (campaign.controllerReservations ?? []).find(
        (item) => item.id === command.reservationId,
      )
      if (
        !reservation ||
        textError(command.actionKey, 'actionKey') ||
        !canReserveControllerAdvance(campaign, command.reservationId, command.generation, now) ||
        reservation.advancesUsed >= reservation.limits.maxAdvances ||
        reservation.advanceKeys.includes(command.actionKey)
      )
        return invalid('controller_advance_denied', 'Bounded controller advance is not available')
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id
            ? {
                ...item,
                advancesUsed: item.advancesUsed + 1,
                advanceKeys: [...item.advanceKeys, command.actionKey.trim()],
              }
            : item,
        ),
      }
      break
    }
    case 'completeBoundedResearch': {
      const control = progressControl(campaign)
      const reservation = (campaign.controllerReservations ?? []).find(
        (item) => item.id === command.reservationId,
      )
      if (
        !reservation ||
        !['active', 'held', 'exhausted'].includes(reservation.status) ||
        control.mode !== 'bounded' ||
        control.reservationRef !== reservation.id ||
        control.generation !== command.generation ||
        reservation.requests.some((item) => item.status === 'sending' || item.status === 'unknown')
      )
        return invalid(
          'controller_complete_denied',
          'Bounded controller cannot complete with unresolved requests',
        )
      next = {
        ...campaign,
        controllerReservations: campaign.controllerReservations!.map((item) =>
          item.id === reservation.id ? { ...item, status: 'completed' } : item,
        ),
        progressControl: {
          mode: 'bounded',
          state: 'exhausted',
          reservationRef: reservation.id,
          generation: control.generation + 1,
        },
      }
      break
    }
    case 'recordCostEvidence': {
      const evidence = command.evidence
      if (
        !evidence ||
        textError(evidence.id, 'cost evidence id') ||
        evidence.id !== evidence.id.trim() ||
        !validCostSubject(campaign, evidence.subject) ||
        textError(evidence.currency, 'cost evidence currency') ||
        evidence.currency !== campaign.budget.currency ||
        !Number.isFinite(evidence.amount) ||
        evidence.amount < 0 ||
        typeof evidence.description !== 'string' ||
        !evidence.description.trim() ||
        evidence.description.length > 2_000 ||
        !SHA256.test(evidence.sourceHash) ||
        (evidence.source !== 'human-attestation' && evidence.source !== 'provider-receipt') ||
        (campaign.costEvidence ?? []).some((item) => item.id === evidence.id.trim())
      )
        return invalid(
          'invalid_cost_evidence',
          'Cost evidence must exactly bind a known budget subject',
        )
      next = {
        ...campaign,
        costEvidence: [
          ...(campaign.costEvidence ?? []),
          {
            ...cloneJson(evidence),
            id: evidence.id.trim(),
            subject: { ...evidence.subject },
            recordedAt: now,
          },
        ],
      }
      break
    }
    case 'settleCostEvidence': {
      const evidence = (campaign.costEvidence ?? []).find((item) => item.id === command.evidenceId)
      const approval = campaign.approvals.find((item) => item.id === command.approvalId)
      const scope = approval?.scope
      if (
        !evidence ||
        !subjectExecutionIsTerminal(campaign, evidence.subject) ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'cost_settlement' ||
        scope.expiresAt <= now ||
        scope.costEvidenceId !== evidence.id ||
        scope.costEvidenceHash !== digest(canonicalJson(evidence)) ||
        scope.costSubjectLabel !== costSubjectLabel(campaign, evidence.subject) ||
        scope.costDescription !== evidence.description ||
        canonicalJson(scope.costSubject) !== canonicalJson(evidence.subject) ||
        scope.currency !== evidence.currency ||
        scope.costAmount !== evidence.amount ||
        scope.maxCost !== evidence.amount ||
        (campaign.costSettlements ?? []).some(
          (item) =>
            item.evidenceId === evidence.id ||
            costSubjectKey(item.subject) === costSubjectKey(evidence.subject),
        )
      )
        return invalid(
          'cost_settlement_approval_required',
          'Settlement requires one active exact human approval for one evidence subject',
        )
      const settlement = {
        id: randomId('rcs'),
        subject: cloneJson(evidence.subject),
        evidenceId: evidence.id,
        approvalId: approval.id,
        currency: evidence.currency,
        amount: evidence.amount,
        settledAt: now,
      }
      next = {
        ...campaign,
        costSettlements: [...(campaign.costSettlements ?? []), settlement],
        approvals: campaign.approvals.map((item) =>
          item.id === approval.id
            ? { ...item, consumedBy: `cost-settlement:${settlement.id}` }
            : item,
        ),
      }
      break
    }
    case 'applyResearchPattern': {
      const selection = command.plan?.selection
      if (!selection || typeof selection !== 'object' || Array.isArray(selection))
        return invalid('invalid_pattern', 'Pattern selection evidence is required')
      const blocked = selection.status === 'blocked' && selection.selectedTemplateId === null
      if (
        (campaign.pattern &&
          ((campaign.pattern.taskRevisionIds.length > 0 &&
            !withDerivedTaskStatuses(campaign).taskRevisions.some(
              (t) =>
                campaign.pattern!.taskRevisionIds.includes(t.id) &&
                ['stale', 'failed', 'interrupted'].includes(t.status),
            )) ||
            campaign.attempts.some((a) => ['running', 'unknown'].includes(a.status)))) ||
        !command.plan ||
        !SHA256.test(command.contractHash) ||
        digest(canonicalJson(command.plan)) !== command.contractHash ||
        command.plan.schema !== 'research-pattern-v1' ||
        !Array.isArray(command.tasks) ||
        (blocked
          ? command.tasks.length !== 0
          : selection.status !== 'selected' ||
            command.tasks.length !== 2 ||
            command.tasks[0]?.templateId !== SYNTHETIC_SUMMARY_TEMPLATE ||
            command.tasks[1]?.templateId !== selection.selectedTemplateId) ||
        command.tasks.some(
          (task) =>
            task.kind !== 'declareSyntheticTask' ||
            task.previousRevisionId !== undefined ||
            task.artifactVersionIds.length !== 0,
        )
      )
        return invalid('invalid_pattern', 'Pattern must be a new bounded fixed plan')
      let compiled = campaign
      const taskRevisionIds: string[] = []
      for (const task of command.tasks) {
        const result = nextCampaign(compiled, task, now)
        if (!result.ok) return result
        compiled = result.campaign
        taskRevisionIds.push(compiled.taskRevisions.at(-1)!.id)
      }
      next = {
        ...compiled,
        stage: 'protocol',
        status: blocked ? 'blocked' : 'proposal',
        ...(campaign.pattern
          ? { patternHistory: [...(campaign.patternHistory ?? []), campaign.pattern] }
          : {}),
        pattern: {
          contractHash: command.contractHash,
          plan: cloneJson(command.plan),
          taskRevisionIds,
        },
      }
      break
    }
    case 'reserveModelReview': {
      const spec = command.spec
      const approval = campaign.approvals.find((a) => a.id === spec?.approvalId)
      const scope = approval?.scope
      if (progressControl(campaign).state === 'held')
        return invalid('progress_held', 'Manual hold blocks new model review reservations')
      if (
        !spec ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'model_review' ||
        scope.expiresAt <= now ||
        scope.dispatchKey !== spec.dispatchKey ||
        scope.evidencePackHash !== spec.evidencePackHash ||
        scope.configHash !== spec.configHash ||
        scope.maxRequests !== spec.maxRequests ||
        scope.maxOutputTokens !== spec.maxOutputTokens ||
        spec.maxRequests !== 2 ||
        spec.maxOutputTokens !== 1024 ||
        !SHA256.test(spec.evidencePackHash) ||
        !SHA256.test(spec.configHash) ||
        spec.currency !== scope.currency ||
        spec.currency !== campaign.budget.currency ||
        !Number.isFinite(spec.reservedCost) ||
        spec.reservedCost <= 0 ||
        spec.reservedCost > scope.maxCost ||
        !Array.isArray(spec.artifactVersionIds) ||
        canonicalJson([...spec.artifactVersionIds].sort()) !==
          canonicalJson([...scope.artifactVersionIds].sort()) ||
        spec.artifactVersionIds.some(
          (id) => !campaign.artifactVersions.some((a) => a.id === id && a.validation),
        ) ||
        (campaign.modelReviews ?? []).some((r) => r.dispatchKey === spec.dispatchKey) ||
        saturatedCostSum([committedCost(campaign), spec.reservedCost]) > campaign.budget.limit
      )
        return invalid(
          'review_approval_required',
          'Review requires exact approved evidence/model/limits and available reserved budget',
        )
      const id = randomId('rmr')
      next = {
        ...campaign,
        modelReviews: [
          ...(campaign.modelReviews ?? []),
          {
            ...cloneJson(spec),
            sourceContextVersion: 2,
            sourceContextHash: reviewSourceContextHash(campaign, 2),
            id,
            ownerPid: process.pid,
            requestCount: 0,
            status: 'reserved',
          },
        ],
        approvals: campaign.approvals.map((a) =>
          a.id === approval.id ? { ...a, consumedBy: id } : a,
        ),
      }
      break
    }
    case 'startModelReviewRequest': {
      const review = campaign.modelReviews?.find((r) => r.id === command.reviewId)
      const approval = campaign.approvals.find((a) => a.id === review?.approvalId)
      if (
        !review ||
        review.ownerPid !== process.pid ||
        !['reserved', 'running'].includes(review.status) ||
        review.requestCount >= review.maxRequests ||
        approval?.status !== 'active' ||
        approval.bundleHash !== campaign.bundleHash ||
        !approval.scope ||
        approval.scope.expiresAt <= now
      )
        return invalid(
          'review_send_denied',
          'Review request is not authorized by the remaining reservation',
        )
      next = {
        ...campaign,
        modelReviews: campaign.modelReviews!.map((r) =>
          r.id === review.id ? { ...r, requestCount: r.requestCount + 1, status: 'running' } : r,
        ),
      }
      break
    }
    case 'finishModelReview': {
      const review = campaign.modelReviews?.find((r) => r.id === command.reviewId)
      if (
        !review ||
        review.ownerPid !== process.pid ||
        !['reserved', 'running'].includes(review.status) ||
        typeof command.text !== 'string' ||
        command.text.length > 16000 ||
        (command.actualCost !== null &&
          (!Number.isFinite(command.actualCost) || command.actualCost < 0))
      )
        return invalid('invalid_review_finish', 'Review result does not bind an active reservation')
      const stale = review.artifactVersionIds.some((id) => {
        const a = campaign.artifactVersions.find((a) => a.id === id)
        return (
          !a ||
          !withDerivedTaskStatuses(campaign).taskRevisions.some(
            (t) => t.id === a.producerTaskRevisionId && t.status === 'verified',
          )
        )
      })
      const status =
        stale || (command.actualCost ?? 0) > review.reservedCost ? 'unknown' : command.status
      next = {
        ...campaign,
        modelReviews: campaign.modelReviews!.map((r) =>
          r.id === review.id
            ? {
                ...r,
                status,
                ...(command.status === 'done'
                  ? { executionOutcome: 'completed' as const }
                  : command.status === 'failed'
                    ? { executionOutcome: 'failed' as const }
                    : {}),
                runId: command.runId,
                conversationId: command.conversationId,
                text: command.text,
                contentHash: digest(command.text),
                actualCost: command.actualCost,
              }
            : r,
        ),
      }
      break
    }
    case 'reserveFormalReview': {
      const spec = command.spec
      const approval = campaign.approvals.find((item) => item.id === spec?.approvalId)
      const scope = approval?.scope
      if (
        !spec ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'formal_code_review' ||
        scope.expiresAt <= now ||
        scope.formalPlanHash !== spec.formalPlanHash ||
        scope.configHash !== spec.configHash ||
        scope.currency !== spec.currency ||
        scope.currency !== campaign.budget.currency ||
        scope.maxCost < spec.reservedCost ||
        spec.maxRequests !== 1 ||
        !Number.isSafeInteger(spec.maxInputCharacters) ||
        spec.maxInputCharacters < 1 ||
        !Number.isSafeInteger(spec.maxOutputTokens) ||
        spec.maxOutputTokens < 1 ||
        !SHA256.test(spec.formalPlanHash) ||
        !SHA256.test(spec.configHash) ||
        !Number.isFinite(spec.reservedCost) ||
        spec.reservedCost <= 0 ||
        !spec.dispatchKey ||
        !spec.reviewId ||
        !validFormalExecutionPlan(spec.plan) ||
        !spec.preparationId ||
        formalExecutionPlanHash(spec.plan) !== spec.formalPlanHash ||
        (campaign.formalReviewDispatches ?? []).some(
          (item) => item.dispatchKey === spec.dispatchKey,
        ) ||
        saturatedCostSum([committedCost(campaign), spec.reservedCost]) > campaign.budget.limit
      )
        return invalid(
          'formal_review_approval_required',
          'Formal review requires exact approved plan, configuration and reserved budget',
        )
      const id = randomId('fdr')
      next = {
        ...campaign,
        formalReviewDispatches: [
          ...(campaign.formalReviewDispatches ?? []),
          {
            ...cloneJson(spec),
            id,
            ownerPid: process.pid,
            status: 'reserved',
          },
        ],
        approvals: campaign.approvals.map((item) =>
          item.id === approval.id ? { ...item, consumedBy: id } : item,
        ),
      }
      break
    }
    case 'startFormalReviewRequest': {
      const review = (campaign.formalReviewDispatches ?? []).find(
        (item) => item.id === command.dispatchId,
      )
      if (
        !review ||
        review.ownerPid !== process.pid ||
        review.status !== 'reserved' ||
        textError(command.requestId, 'requestId') !== null
      )
        return invalid(
          'formal_review_send_denied',
          'Formal review dispatch is not available for send',
        )
      next = {
        ...campaign,
        formalReviewDispatches: campaign.formalReviewDispatches!.map((item) =>
          item.id === review.id
            ? { ...item, status: 'sending', requestId: command.requestId }
            : item,
        ),
      }
      break
    }
    case 'finishFormalReview': {
      const dispatch = (campaign.formalReviewDispatches ?? []).find(
        (item) => item.id === command.dispatchId,
      )
      if (
        !dispatch ||
        dispatch.ownerPid !== process.pid ||
        dispatch.status !== 'sending' ||
        (command.actualCost !== null &&
          (!Number.isFinite(command.actualCost) || command.actualCost < 0)) ||
        (command.status === 'done' && !validFormalCodeReviewResult(command.result))
      )
        return invalid(
          'invalid_formal_review_finish',
          'Formal review completion does not bind an in-flight dispatch',
        )
      next = {
        ...campaign,
        formalReviewDispatches: campaign.formalReviewDispatches!.map((item) =>
          item.id === dispatch.id
            ? {
                ...item,
                status: command.status,
                ...(command.result ? { result: cloneJson(command.result) } : {}),
                actualCost: command.actualCost,
              }
            : item,
        ),
      }
      break
    }
    case 'recordFormalCodeReview': {
      const result = command.result
      const plan = command.plan
      if (
        !validFormalCodeReviewResult(result) ||
        !validFormalExecutionPlan(plan) ||
        !formalReviewMatchesPlan(result, plan)
      )
        return invalid('invalid_formal_code_review', 'Formal code review result is malformed')
      const artifact = campaign.artifactVersions.find(
        (item) => item.id === result.candidateArtifactId,
      )
      const candidateAttempt = campaign.attempts.find(
        (item) =>
          item.artifactVersionId === artifact?.id && item.taskRevisionId === result.taskRevisionId,
      )
      const task = withDerivedTaskStatuses(campaign).taskRevisions.find(
        (item) => item.id === result.taskRevisionId,
      )
      if (
        !artifact ||
        !['cli_preparation_candidate', 'cli_preparation_quarantined_candidate'].includes(
          artifact.kind,
        ) ||
        artifact.contentHash !== result.candidateReceiptHash ||
        (artifact.producerTaskRevisionId !== result.taskRevisionId && !candidateAttempt) ||
        task?.status === 'stale' ||
        !(campaign.labelSets ?? []).some((item) => item.contentHash === plan.labelSetContentHash) ||
        !(task?.labelSetContentHashes ?? []).includes(plan.labelSetContentHash) ||
        (campaign.formalCodeReviews ?? []).some((item) => item.reviewId === result.reviewId)
      )
        return invalid(
          'formal_review_basis_stale',
          'Formal review must bind one current candidate receipt',
        )
      if (result.reviewKind === 'isolated-api') {
        const approval = campaign.approvals.find((item) => item.id === command.approvalId)
        const scope = approval?.scope
        const dispatched = (campaign.formalReviewDispatches ?? []).find(
          (item) =>
            item.approvalId === command.approvalId &&
            item.reviewId === result.reviewId &&
            item.status === 'done' &&
            item.result?.runnerReceiptHash === result.runnerReceiptHash,
        )
        if (
          !approval ||
          approval.status !== 'active' ||
          (!dispatched && approval.consumedBy) ||
          approval.bundleHash !== campaign.bundleHash ||
          scope?.kind !== 'formal_code_review' ||
          scope.expiresAt <= now ||
          scope.formalEvaluatorId !== result.trustedEvaluatorId ||
          scope.artifactVersionIds.length !== 1 ||
          scope.artifactVersionIds[0] !== artifact.id ||
          scope.formalPlanHash !== formalExecutionPlanHash(plan) ||
          canonicalJson(scope.formalResources) !== canonicalJson(plan.resources) ||
          !result.runnerReceiptHash ||
          command.reviewer !== undefined ||
          (dispatched && dispatched.formalPlanHash !== formalExecutionPlanHash(plan))
        )
          return invalid(
            'formal_review_approval_required',
            'Isolated review needs an exact independent cost approval',
          )
        next = {
          ...campaign,
          formalCodeReviews: [...(campaign.formalCodeReviews ?? []), cloneJson(result)],
          approvals: campaign.approvals.map((item) =>
            item.id === approval.id && !item.consumedBy
              ? { ...item, consumedBy: `formal-review:${result.reviewId}` }
              : item,
          ),
        }
      } else {
        const proofError = command.reviewer
          ? validateProof(command.reviewer)
          : 'independent human proof required'
        if (
          proofError ||
          command.approvalId !== undefined ||
          result.runnerReceiptHash !== undefined ||
          command.reviewer!.reviewerId !== result.reviewerId
        )
          return invalid(
            'human_formal_review_proof_required',
            'Human review must carry an independent signed proof',
          )
        next = {
          ...campaign,
          formalCodeReviews: [...(campaign.formalCodeReviews ?? []), cloneJson(result)],
        }
      }
      break
    }
    case 'freezeFormalExecutionPlan': {
      const plan = command.plan
      const approval = campaign.approvals.find((item) => item.id === command.approvalId)
      const scope = approval?.scope
      const artifact = validFormalExecutionPlan(plan)
        ? campaign.artifactVersions.find((item) => item.id === plan.candidateArtifactId)
        : undefined
      const candidateAttempt = validFormalExecutionPlan(plan)
        ? campaign.attempts.find(
            (item) =>
              item.artifactVersionId === artifact?.id &&
              item.taskRevisionId === plan.taskRevisionId,
          )
        : undefined
      const task = validFormalExecutionPlan(plan)
        ? withDerivedTaskStatuses(campaign).taskRevisions.find(
            (item) => item.id === plan.taskRevisionId,
          )
        : undefined
      const reviewed = validFormalExecutionPlan(plan)
        ? (campaign.formalCodeReviews ?? []).some(
            (item) => item.decision === 'accepted' && formalReviewMatchesPlan(item, plan),
          )
        : false
      if (
        !validFormalExecutionPlan(plan) ||
        command.planHash !== formalExecutionPlanHash(plan) ||
        !artifact ||
        artifact.contentHash !== plan.candidateReceiptHash ||
        !['cli_preparation_candidate', 'cli_preparation_quarantined_candidate'].includes(
          artifact.kind,
        ) ||
        (artifact.producerTaskRevisionId !== plan.taskRevisionId && !candidateAttempt) ||
        task?.status === 'stale' ||
        !(campaign.labelSets ?? []).some((item) => item.contentHash === plan.labelSetContentHash) ||
        !(task?.labelSetContentHashes ?? []).includes(plan.labelSetContentHash) ||
        !reviewed ||
        (campaign.formalExecutionPlans ?? []).some((item) => item.planId === plan.planId) ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'formal_execution' ||
        scope.expiresAt <= now ||
        scope.formalPlanHash !== command.planHash ||
        scope.formalEvaluatorId !== plan.trustedEvaluatorId ||
        canonicalJson(scope.formalResources) !== canonicalJson(plan.resources) ||
        scope.artifactVersionIds.length !== 1 ||
        scope.artifactVersionIds[0] !== artifact.id
      )
        return invalid(
          'formal_execution_approval_required',
          'Formal plan requires accepted current review and exact approval',
        )
      next = {
        ...campaign,
        formalExecutionPlans: [...(campaign.formalExecutionPlans ?? []), cloneJson(plan)],
        approvals: campaign.approvals.map((item) =>
          item.id === approval.id ? { ...item, consumedBy: `formal-plan:${plan.planId}` } : item,
        ),
      }
      break
    }
    case 'reserveFormalExecution': {
      const plan = (campaign.formalExecutionPlans ?? []).find(
        (item) => item.planId === command.planId,
      )
      const approval = campaign.approvals.find((item) => item.id === command.approvalId)
      const scope = approval?.scope
      if (
        progressControl(campaign).state !== 'active' ||
        !plan ||
        formalExecutionPlanHash(plan) !== command.planHash ||
        plan.workspaceBindingHash !== command.workspaceBindingHash ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        scope?.kind !== 'formal_execution' ||
        scope.expiresAt <= now ||
        scope.formalPlanHash !== command.planHash ||
        scope.formalEvaluatorId !== plan.trustedEvaluatorId ||
        canonicalJson(scope.formalResources) !== canonicalJson(plan.resources) ||
        scope.maxCost < command.reservedMaxCost ||
        scope.currency !== campaign.budget.currency ||
        ![command.routeId, command.profileId, command.remoteRoot, command.authorityId].every(
          (item) => typeof item === 'string' && item.trim().length > 0,
        ) ||
        ![
          command.connectionHash,
          command.workspaceBindingHash,
          command.admissionEvidenceHash,
        ].every((item) => SHA256.test(item)) ||
        !Number.isFinite(command.reservedMaxCost) ||
        command.reservedMaxCost < 0 ||
        (campaign.formalExecutionDispatches ?? []).some((item) => item.planId === plan.planId) ||
        saturatedCostSum([committedCost(campaign), command.reservedMaxCost]) > campaign.budget.limit
      )
        return invalid(
          'formal_execution_approval_required',
          'Formal execution requires the frozen exact plan, current approval and reserved budget',
        )
      const id = randomId('fed')
      next = {
        ...campaign,
        formalExecutionDispatches: [
          ...(campaign.formalExecutionDispatches ?? []),
          {
            id,
            planId: plan.planId,
            planHash: command.planHash,
            attemptId: null,
            approvalId: approval.id,
            routeId: command.routeId,
            profileId: command.profileId,
            workspaceBindingHash: command.workspaceBindingHash,
            connectionHash: command.connectionHash,
            remoteRoot: command.remoteRoot,
            authorityId: command.authorityId,
            admissionEvidenceHash: command.admissionEvidenceHash,
            reservedMaxCost: command.reservedMaxCost,
            status: 'reserved' as const,
          },
        ],
        approvals: campaign.approvals.map((item) =>
          item.id === approval.id ? { ...item, consumedBy: `formal-execution:${id}` } : item,
        ),
      }
      break
    }
    case 'claimFormalExecution': {
      const dispatch = (campaign.formalExecutionDispatches ?? []).find(
        (item) => item.id === command.dispatchId,
      )
      const plan = dispatch
        ? (campaign.formalExecutionPlans ?? []).find((item) => item.planId === dispatch.planId)
        : undefined
      if (
        progressControl(campaign).state !== 'active' ||
        !dispatch ||
        !plan ||
        dispatch.status !== 'reserved' ||
        dispatch.attemptId !== null
      )
        return invalid(
          'formal_execution_claim_denied',
          'Formal execution dispatch is not available',
        )
      const attemptId = randomId('rat')
      const attempt: ResearchAttempt = {
        id: attemptId,
        taskRevisionId: plan.taskRevisionId,
        dispatchKey: attemptId,
        backend: 'ssh-daemon',
        ownerPid: process.pid,
        status: 'running',
        executionStartedAt: now,
        endedAt: null,
        artifactVersionId: null,
        error: null,
        cancelRequestedAt: null,
      }
      next = {
        ...campaign,
        attempts: [...campaign.attempts, attempt],
        formalExecutionDispatches: campaign.formalExecutionDispatches!.map((item) =>
          item.id === dispatch.id ? { ...item, attemptId, status: 'bound' as const } : item,
        ),
      }
      break
    }
    case 'bindFormalExecutionJob': {
      const dispatch = (campaign.formalExecutionDispatches ?? []).find(
        (item) => item.id === command.dispatchId,
      )
      const attempt = attemptById(campaign, command.attemptId)
      const plan = dispatch
        ? (campaign.formalExecutionPlans ?? []).find((item) => item.planId === dispatch.planId)
        : undefined
      const specHash = command.spec ? digest(canonicalJson(command.spec)) : ''
      if (
        !dispatch ||
        !plan ||
        !attempt ||
        dispatch.attemptId !== attempt.id ||
        attempt.status !== 'running' ||
        attempt.formalExecutionJobSpec ||
        !command.spec ||
        command.spec.version !== 4 ||
        command.spec.campaignId !== campaign.id ||
        command.spec.taskRevisionId !== plan.taskRevisionId ||
        command.spec.dispatchKey !== attempt.id ||
        command.spec.formalPlanHash !== dispatch.planHash ||
        canonicalJson(command.spec.formalPlan) !== canonicalJson(plan) ||
        command.spec.execution.authorityEpoch !== command.authority?.epoch ||
        !AUTHORITY_EPOCH.test(command.authority?.epoch ?? '') ||
        command.authority?.schema !== 'formal-execution-authority-binding-v1' ||
        command.authority.routeId !== dispatch.routeId ||
        command.authority.profileId !== dispatch.profileId ||
        command.authority.workspaceBindingHash !== dispatch.workspaceBindingHash ||
        command.authority.connectionHash !== dispatch.connectionHash ||
        command.authority.remoteRoot !== dispatch.remoteRoot ||
        command.authority.authorityId !== dispatch.authorityId ||
        command.authority.admissionEvidenceHash !== dispatch.admissionEvidenceHash ||
        command.authority.jobSpecHash !== specHash ||
        command.authority.dispatchState !== 'not_sent'
      )
        return invalid(
          'invalid_formal_execution_binding',
          'Formal job must bind the reserved route and exact plan',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((item) =>
          item.id === attempt.id
            ? {
                ...item,
                formalExecutionJobSpec: cloneJson(command.spec),
                formalExecutionJobSpecHash: specHash,
                formalExecutionAuthority: cloneJson(command.authority),
              }
            : item,
        ),
      }
      break
    }
    case 'claimFormalExecutionDispatch':
    case 'acquireFormalExecutionObservation': {
      const attempt = attemptById(campaign, command.attemptId)
      const binding = attempt?.formalExecutionAuthority
      const prior = binding?.observer
      const renewal = prior?.instanceId === command.instanceId && prior.expiresAt > now
      const first = command.kind === 'claimFormalExecutionDispatch'
      if (
        !attempt ||
        !binding ||
        !validObserverLease(command, now) ||
        !formalAuthorityMatches(attempt, command.expectedEpoch, command.expectedJobSpecHash) ||
        !['running', 'unknown'].includes(attempt.status) ||
        (first ? binding.dispatchState !== 'not_sent' : binding.dispatchState === 'not_sent') ||
        (!first && prior !== undefined && prior.expiresAt > now && !renewal) ||
        (!first && renewal && command.leaseExpiresAt < prior.expiresAt)
      )
        return invalid(
          'invalid_formal_execution_observer',
          'Formal execution observer lease is not current',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((item) =>
          item.id === attempt.id
            ? {
                ...item,
                formalExecutionAuthority: {
                  ...binding,
                  dispatchState: first ? 'sending' : binding.dispatchState,
                  observer: {
                    instanceId: command.instanceId,
                    generation: first
                      ? 1
                      : renewal
                        ? prior!.generation
                        : (prior?.generation ?? 0) + 1,
                    expiresAt: command.leaseExpiresAt,
                  },
                },
              }
            : item,
        ),
      }
      break
    }
    case 'acknowledgeFormalExecutionDispatch':
    case 'markFormalExecutionObservationUnknown': {
      const attempt = attemptById(campaign, command.attemptId)
      const binding = attempt?.formalExecutionAuthority
      if (
        !attempt ||
        !binding ||
        binding.epoch !== command.expectedEpoch ||
        !currentFormalObserver(
          attempt,
          { instanceId: command.instanceId, generation: command.generation },
          now,
        )
      )
        return invalid('stale_formal_execution_observer', 'Formal execution observer is stale')
      const acknowledge = command.kind === 'acknowledgeFormalExecutionDispatch'
      if (acknowledge && binding.dispatchState !== 'sending')
        return invalid(
          'invalid_formal_execution_acknowledgement',
          'Formal execution was not sending',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((item) =>
          item.id === attempt.id
            ? {
                ...item,
                status: acknowledge ? item.status : 'unknown',
                error: acknowledge ? item.error : 'Authority observation is unknown',
                formalExecutionAuthority: {
                  ...binding,
                  dispatchState: acknowledge ? 'acknowledged' : 'observation_unknown',
                },
              }
            : item,
        ),
        formalExecutionDispatches: (campaign.formalExecutionDispatches ?? []).map((item) =>
          item.attemptId === attempt.id && !acknowledge
            ? { ...item, status: 'unknown' as const }
            : item,
        ),
      }
      break
    }
    case 'finishFormalExecution': {
      const attempt = attemptById(campaign, command.attemptId)
      const dispatch = (campaign.formalExecutionDispatches ?? []).find(
        (item) => item.attemptId === attempt?.id,
      )
      if (
        !attempt ||
        !dispatch ||
        !currentFormalObserver(attempt, command.observer, now) ||
        attempt.cancelRequestedAt !== null ||
        !SHA256.test(command.contentHash) ||
        !SHA256.test(command.receiptHash) ||
        command.contentHash !== command.receiptHash ||
        textError(command.uri, 'uri')
      )
        return invalid(
          'invalid_formal_execution_finish',
          'Formal execution receipt is not admissible',
        )
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId: dispatch.planId,
        version: 1,
        uri: command.uri.trim(),
        kind: 'formal_execution_receipt',
        contentHash: command.contentHash,
        createdAt: now,
        mediaType: 'application/json',
        dataClass: 'restricted-reference',
        schemaId: 'research-formal-oci-receipt-v1',
        producerAttemptId: attempt.id,
        producerTaskRevisionId: attempt.taskRevisionId,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        attempts: campaign.attempts.map((item) =>
          item.id === attempt.id
            ? { ...item, status: 'completed', endedAt: now, artifactVersionId: artifact.id }
            : item,
        ),
        formalExecutionDispatches: campaign.formalExecutionDispatches!.map((item) =>
          item.id === dispatch.id
            ? { ...item, status: 'completed', receiptHash: command.receiptHash }
            : item,
        ),
      }
      break
    }
    case 'recordLiteratureCitation': {
      const citation = command.citation
      if (
        !citation ||
        citation.sourceKind !== 'public-metadata' ||
        citation.fullText !== false ||
        citation.verification !== 'retrieved-public-metadata' ||
        !SHA256.test(citation.contentHash) ||
        !SHA256.test(citation.projectionHash)
      )
        return invalid('invalid_literature_citation', 'Verified public metadata citation required')
      const {
        projectionHash,
        verification: _verification,
        fullText: _fullText,
        ...source
      } = citation
      if (
        digest(canonicalJson(source)) !== projectionHash ||
        (campaign.literatureCitations ?? []).some((c) => c.id === citation.id)
      )
        return invalid(
          'invalid_literature_citation',
          'Citation projection hash changed or duplicated',
        )
      next = {
        ...campaign,
        literatureCitations: [...(campaign.literatureCitations ?? []), cloneJson(citation)],
      }
      break
    }
    case 'recordLabelSet': {
      if (validateProof(command.reviewer))
        return invalid('invalid_reviewer', 'Trusted signer proof required')
      try {
        const reference = validateLabelSetReference(command.reference)
        const previous = (campaign.labelSets ?? [])
          .filter((ref) => ref.id === reference.id)
          .toSorted((a, b) => b.version - a.version)[0]
        if (previous) validateLabelSetSuccessor(previous, reference)
        else if (reference.version !== 1)
          return invalid('invalid_labelset_revision', 'Initial LabelSet must start at version 1')
        next = { ...campaign, labelSets: [...(campaign.labelSets ?? []), cloneJson(reference)] }
      } catch {
        return invalid('invalid_labelset', 'Invalid immutable aggregate LabelSet reference')
      }
      break
    }
    case 'setPolicy': {
      const error = jsonObject(command.policy, 'policy')
      if (error) return invalid('invalid_policy', error)
      next = { ...campaign, policy: cloneJson(command.policy), status: 'proposal' }
      break
    }
    case 'setInputs': {
      const error = jsonObject(command.inputs, 'inputs')
      if (error) return invalid('invalid_inputs', error)
      next = { ...campaign, inputs: cloneJson(command.inputs), status: 'proposal' }
      break
    }
    case 'setBudget': {
      const error = budgetError(command.budget)
      if (error) return invalid('invalid_budget', error)
      if (
        committedCost(campaign) > command.budget.limit ||
        (hasCostCommitment(campaign) && command.budget.currency !== campaign.budget.currency)
      )
        return invalid(
          'reserved_budget',
          'Existing review reservations cannot be reduced or converted',
        )
      next = { ...campaign, budget: cloneJson(command.budget), status: 'proposal' }
      break
    }
    case 'proposeCliPreparation': {
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === command.taskRevisionId,
      )
      const error =
        textError(command.preparationId, 'preparationId') ??
        textError(command.dispatchKey, 'dispatchKey') ??
        textError(command.candidateId, 'candidateId') ??
        textError(command.adapterId, 'adapterId') ??
        (!SHA256.test(command.adapterConfigHash) ? 'adapterConfigHash 无效' : null) ??
        (!SHA256.test(command.backendPolicyHash) ? 'backendPolicyHash 无效' : null) ??
        textError(command.model, 'model') ??
        textError(command.deviceId, 'deviceId') ??
        (typeof command.instructions !== 'string' ||
        command.instructions.length < 1 ||
        command.instructions.length > 32_000
          ? 'instructions 无效'
          : null) ??
        (!SHA256.test(command.inputHash) ? 'inputHash 无效' : null) ??
        (!SHA256.test(command.configHash) ? 'configHash 无效' : null) ??
        (command.configHash !== cliPreparationConfigHash({ ...command, id: command.preparationId })
          ? 'configHash 未绑定完整准备规格'
          : null) ??
        (!Number.isSafeInteger(command.maxRuntimeMs) ||
        command.maxRuntimeMs < 1 ||
        command.maxRuntimeMs > 600_000
          ? 'maxRuntimeMs 无效'
          : null) ??
        (!Number.isFinite(command.maxCost) ||
        command.maxCost <= 0 ||
        command.maxCost > campaign.budget.limit
          ? 'maxCost 无效'
          : null) ??
        (command.acknowledgeUnknownCost !== true ? '必须确认 CLI 实际费用未知' : null)
      if (
        error ||
        !task ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        task.inputHash !== command.inputHash ||
        (campaign.cliPreparations ?? []).some(
          (candidate) =>
            candidate.id === command.preparationId || candidate.dispatchKey === command.dispatchKey,
        ) ||
        campaign.attempts.some((attempt) => attempt.dispatchKey === command.dispatchKey)
      )
        return invalid('invalid_cli_preparation_proposal', error ?? '任务版本或 dispatchKey 不可用')
      const preparation: ResearchCliPreparation = {
        id: command.preparationId,
        taskRevisionId: task.id,
        dispatchKey: command.dispatchKey,
        candidateId: command.candidateId,
        adapterId: command.adapterId,
        adapterConfigHash: command.adapterConfigHash,
        backendPolicyHash: command.backendPolicyHash,
        model: command.model,
        instructions: command.instructions,
        inputHash: command.inputHash,
        configHash: command.configHash,
        deviceId: command.deviceId,
        maxRuntimeMs: command.maxRuntimeMs,
        maxCost: command.maxCost,
        acknowledgeUnknownCost: true,
        actualCost: null,
        status: 'proposed',
        attemptId: null,
        artifactVersionId: null,
        createdAt: now,
      }
      next = { ...campaign, cliPreparations: [...(campaign.cliPreparations ?? []), preparation] }
      break
    }
    case 'claimCliPreparation': {
      const preparation = (campaign.cliPreparations ?? []).find(
        (candidate) => candidate.id === command.preparationId,
      )
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === preparation?.taskRevisionId,
      )
      const approval = campaign.approvals.find((candidate) => candidate.id === command.approvalId)
      if (progressControl(campaign).state === 'held')
        return invalid('progress_held', 'Manual hold blocks new CLI preparation claims')
      if (
        !preparation ||
        !task ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        preparation.status !== 'proposed' ||
        preparation.inputHash !== task.inputHash ||
        preparation.configHash !== cliPreparationConfigHash(preparation) ||
        approval?.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        approval.scope?.kind !== 'cli_preparation' ||
        approval.scope.expiresAt <= now ||
        approval.scope.taskRevisionId !== task.id ||
        approval.scope.dispatchKey !== preparation.dispatchKey ||
        approval.scope.configHash !== preparation.configHash ||
        approval.scope.maxCost !== preparation.maxCost ||
        approval.scope.backendPolicyHash !== preparation.backendPolicyHash ||
        approval.scope.preparationLimits?.maxRuntimeMs !== preparation.maxRuntimeMs ||
        approval.scope.preparationLimits?.cpu !== 1 ||
        approval.scope.preparationLimits?.memoryMb !== 256 ||
        approval.scope.preparationLimits?.adapterConfigHash !== preparation.adapterConfigHash ||
        approval.scope.preparationLimits?.acknowledgeUnknownCost !== true ||
        saturatedCostSum([committedCost(campaign), preparation.maxCost]) > campaign.budget.limit ||
        campaign.attempts.some((attempt) => attempt.dispatchKey === preparation.dispatchKey)
      )
        return invalid('cli_preparation_approval_required', '准备任务需要精确且未消费的人类审批')
      const attempt: ResearchAttempt = {
        id: randomId('rat'),
        taskRevisionId: task.id,
        dispatchKey: preparation.dispatchKey,
        backend: 'ssh-daemon',
        backendPolicyHash: preparation.backendPolicyHash,
        ownerPid: process.pid,
        status: 'running',
        executionStartedAt: now,
        endedAt: null,
        artifactVersionId: null,
        error: null,
        cancelRequestedAt: null,
      }
      next = {
        ...campaign,
        attempts: [...campaign.attempts, attempt],
        cliPreparations: (campaign.cliPreparations ?? []).map((candidate) =>
          candidate.id === preparation.id
            ? { ...candidate, status: 'claimed', attemptId: attempt.id }
            : candidate,
        ),
        approvals: campaign.approvals.map((candidate) =>
          candidate.id === approval.id ? { ...candidate, consumedBy: attempt.id } : candidate,
        ),
      }
      break
    }
    case 'bindCliPreparationJob': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      const preparation = (campaign.cliPreparations ?? []).find(
        (candidate) => candidate.attemptId === owned.attempt.id,
      )
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === owned.attempt.taskRevisionId,
      )
      const spec = command.spec
      if (
        !preparation ||
        !task ||
        preparation.status !== 'claimed' ||
        owned.attempt.backend !== 'ssh-daemon' ||
        owned.attempt.cliPreparationJobSpec ||
        owned.attempt.jobSpec ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        preparation.inputHash !== task.inputHash ||
        preparation.configHash !== cliPreparationConfigHash(preparation) ||
        !spec ||
        spec.version !== 3 ||
        spec.campaignId !== campaign.id ||
        spec.taskRevisionId !== task.id ||
        spec.templateId !== task.templateId ||
        spec.inputHash !== preparation.inputHash ||
        spec.dispatchKey !== owned.attempt.id ||
        spec.backendPolicyHash !== preparation.backendPolicyHash ||
        spec.resource?.cpu !== 1 ||
        spec.resource?.memoryMb !== 256 ||
        textError(spec.lease?.ownerId, 'lease owner') !== null ||
        !Number.isSafeInteger(spec.lease?.fence) ||
        spec.lease.fence < 1 ||
        !Number.isSafeInteger(spec.lease.expiresAt) ||
        spec.lease.expiresAt <= now ||
        spec.lease.expiresAt > now + 10 * 60 * 1000 ||
        textError(spec.lease.token, 'lease token') ||
        (command.authorityEpoch !== undefined && !AUTHORITY_EPOCH.test(command.authorityEpoch)) ||
        spec.execution?.adapter !== 'cli-preparation-v1' ||
        spec.execution.preparationId !== preparation.id ||
        spec.execution.candidateId !== preparation.candidateId ||
        spec.execution.clientDispatchKey !== preparation.dispatchKey ||
        spec.execution.adapterId !== preparation.adapterId ||
        spec.execution.adapterConfigHash !== preparation.adapterConfigHash ||
        spec.execution.model !== preparation.model ||
        spec.execution.instructions !== preparation.instructions ||
        spec.execution.configHash !== preparation.configHash ||
        spec.execution.deviceId !== preparation.deviceId ||
        spec.execution.maxRuntimeMs !== preparation.maxRuntimeMs ||
        spec.execution.maxCost !== preparation.maxCost
      )
        return invalid(
          'invalid_cli_preparation_job',
          'Job must bind the claimed approved preparation',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                cliPreparationJobSpec: cloneJson(spec),
                cliPreparationJobSpecHash: digest(canonicalJson(spec)),
                ...(command.authorityEpoch
                  ? {
                      cliPreparationAuthority: {
                        schema: 'cli-preparation-authority-binding-v1' as const,
                        epoch: command.authorityEpoch,
                        backendPolicyHash: spec.backendPolicyHash,
                        jobSpecHash: digest(canonicalJson(spec)),
                        dispatchState: 'not_sent' as const,
                      },
                    }
                  : {}),
              }
            : attempt,
        ),
      }
      break
    }
    case 'finishCliPreparation': {
      const owned = ownedRunningAttempt(campaign, command.attemptId, command.observer, now)
      if (!owned.ok) return owned
      const preparation = (campaign.cliPreparations ?? []).find(
        (candidate) => candidate.attemptId === owned.attempt.id,
      )
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === owned.attempt.taskRevisionId,
      )
      const spec = owned.attempt.cliPreparationJobSpec
      const validation = command.validation
      const consumedApproval = campaign.approvals.find(
        (candidate) => candidate.consumedBy === owned.attempt.id,
      )
      if (
        owned.attempt.cancelRequestedAt !== null ||
        consumedApproval?.status === 'revoked' ||
        !preparation ||
        !task ||
        preparation.status !== 'claimed' ||
        !spec ||
        !owned.attempt.cliPreparationJobSpecHash ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        task.inputHash !== preparation.inputHash ||
        !SHA256.test(command.contentHash) ||
        textError(command.uri, 'uri') !== null ||
        command.artifactKind !== 'cli_preparation_candidate' ||
        !validation ||
        validation.schema !== 'research-cli-preparation-candidate-v1' ||
        validation.jobSpecHash !== owned.attempt.cliPreparationJobSpecHash ||
        validation.dispatchKey !== owned.attempt.id ||
        validation.clientDispatchKey !== preparation.dispatchKey ||
        validation.preparationId !== preparation.id ||
        validation.candidateId !== preparation.candidateId ||
        validation.taskRevisionId !== task.id ||
        validation.inputHash !== preparation.inputHash ||
        validation.configHash !== preparation.configHash ||
        validation.contentHash !== command.contentHash ||
        !SHA256.test(validation.draftContentHash) ||
        !Number.isSafeInteger(validation.byteLength) ||
        validation.byteLength < 0 ||
        !Number.isSafeInteger(validation.verifiedAt) ||
        validation.verifiedAt <= 0
      )
        return invalid(
          'invalid_cli_preparation_finish',
          'Candidate receipt does not bind the frozen job',
        )
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId: `cli-preparation:${preparation.id}`,
        version: 1,
        uri: command.uri.trim(),
        kind: 'cli_preparation_candidate',
        mediaType: 'application/json',
        dataClass: task.dataClass,
        schemaId: 'research-cli-preparation-candidate-v1',
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? { ...attempt, status: 'completed', endedAt: now, artifactVersionId: artifact.id }
            : attempt,
        ),
        cliPreparations: (campaign.cliPreparations ?? []).map((candidate) =>
          candidate.id === preparation.id
            ? { ...candidate, status: 'candidate', artifactVersionId: artifact.id }
            : candidate,
        ),
      }
      break
    }
    case 'quarantineCliPreparationResult': {
      const owned = ownedRunningAttempt(campaign, command.attemptId, command.observer, now)
      if (!owned.ok) return owned
      const preparation = (campaign.cliPreparations ?? []).find(
        (candidate) => candidate.attemptId === owned.attempt.id,
      )
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === owned.attempt.taskRevisionId,
      )
      const spec = owned.attempt.cliPreparationJobSpec
      const validation = command.validation
      const approval = campaign.approvals.find(
        (candidate) => candidate.consumedBy === owned.attempt.id,
      )
      if (
        (owned.attempt.cancelRequestedAt === null && approval?.status !== 'revoked') ||
        !preparation ||
        !task ||
        preparation.status !== 'claimed' ||
        !spec ||
        !owned.attempt.cliPreparationJobSpecHash ||
        !SHA256.test(command.contentHash) ||
        textError(command.uri, 'uri') !== null ||
        !validation ||
        validation.schema !== 'research-cli-preparation-candidate-v1' ||
        validation.jobSpecHash !== owned.attempt.cliPreparationJobSpecHash ||
        validation.dispatchKey !== owned.attempt.id ||
        validation.clientDispatchKey !== preparation.dispatchKey ||
        validation.preparationId !== preparation.id ||
        validation.candidateId !== preparation.candidateId ||
        validation.taskRevisionId !== task.id ||
        validation.inputHash !== preparation.inputHash ||
        validation.configHash !== preparation.configHash ||
        validation.contentHash !== command.contentHash ||
        !SHA256.test(validation.draftContentHash) ||
        !Number.isSafeInteger(validation.byteLength) ||
        validation.byteLength < 0 ||
        !Number.isSafeInteger(validation.verifiedAt) ||
        validation.verifiedAt <= 0
      )
        return invalid(
          'invalid_cli_preparation_quarantine',
          'Quarantined receipt does not bind the original cancelled preparation',
        )
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId: `cli-preparation-quarantine:${preparation.id}`,
        version: 1,
        uri: command.uri.trim(),
        kind: 'cli_preparation_quarantined_candidate',
        mediaType: 'application/json',
        dataClass: task.dataClass,
        schemaId: 'research-cli-preparation-candidate-v1',
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: 'cancelled',
                endedAt: now,
                artifactVersionId: artifact.id,
                executionOutcome: 'completed',
                resultDisposition: 'quarantined',
              }
            : attempt,
        ),
      }
      break
    }
    case 'recordArtifact': {
      const error =
        textError(command.artifactId, 'artifactId') ??
        textError(command.uri, 'uri') ??
        textError(command.artifactKind, 'artifactKind') ??
        (!SHA256.test(command.contentHash)
          ? 'contentHash 必须是 sha256: 后接 64 位小写十六进制'
          : null)
      if (error) return invalid('invalid_artifact', error)
      const artifactId = command.artifactId.trim()
      const lastVersion = campaign.artifactVersions
        .filter((artifact) => artifact.artifactId === artifactId)
        .reduce((max, artifact) => Math.max(max, artifact.version), 0)
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId,
        version: lastVersion + 1,
        uri: command.uri.trim(),
        kind: command.artifactKind.trim(),
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        status: 'proposal',
      }
      break
    }
    case 'approve': {
      const error =
        (!SHA256.test(command.bundleHash)
          ? 'bundleHash 必须是 sha256: 后接 64 位小写十六进制'
          : null) ?? validateProof(command.reviewer)
      if (error) return invalid('invalid_approval', error)
      if (command.bundleHash !== campaign.bundleHash) {
        return invalid('stale_bundle', '审批绑定的 bundleHash 与当前研究包不一致')
      }
      if (command.scope !== undefined) {
        const scope = command.scope
        const derivedCampaign = withDerivedTaskStatuses(campaign)
        const scopedTask = derivedCampaign.taskRevisions.find(
          (task) => task.id === scope?.taskRevisionId,
        )
        const cliPreparation =
          scope?.kind === 'cli_preparation'
            ? (campaign.cliPreparations ?? []).find(
                (candidate) =>
                  candidate.status === 'proposed' &&
                  candidate.taskRevisionId === scope.taskRevisionId &&
                  candidate.dispatchKey === scope.dispatchKey &&
                  candidate.configHash === scope.configHash &&
                  candidate.maxCost === scope.maxCost &&
                  candidate.backendPolicyHash === scope.backendPolicyHash,
              )
            : undefined
        const costEvidence =
          scope?.kind === 'cost_settlement'
            ? (campaign.costEvidence ?? []).find(
                (candidate) => candidate.id === scope.costEvidenceId,
              )
            : undefined
        if (
          !scope ||
          (scope.display !== undefined &&
            (!scope.display ||
              Object.keys(scope.display).sort().join(',') !== 'revision,task,title' ||
              scope.display.title !== campaign.goal ||
              scope.display.task !== scopedTask?.templateId ||
              scope.display.revision !== scopedTask?.revision)) ||
          (scope.kind === 'execution' &&
            scopedTask?.templateId === 'supervised-phantom-v2' &&
            (scope.executionLimits?.maxRuntimeMs !== 600_000 ||
              scope.executionLimits.cpu !== 1 ||
              scope.executionLimits.memoryMb !== 256 ||
              scope.executionLimits.codeHash !== scopedTask.skillBinding?.sourceHash ||
              scope.executionLimits.inputHash !== scopedTask.inputHash)) ||
          (scope.trackingPolicyHash !== undefined &&
            (scope.kind !== 'execution' || !SHA256.test(scope.trackingPolicyHash))) ||
          (scope.backendPolicyHash !== undefined &&
            (!['execution', 'cli_preparation'].includes(scope.kind) ||
              !SHA256.test(scope.backendPolicyHash))) ||
          ![
            'protocol',
            'execution',
            'cli_preparation',
            'model_review',
            'release',
            'cost_settlement',
            'controller',
            'formal_code_review',
            'formal_execution',
          ].includes(scope.kind) ||
          !Number.isSafeInteger(scope.expiresAt) ||
          scope.expiresAt <= now ||
          scope.expiresAt > now + 24 * 60 * 60 * 1000 ||
          scope.currency !== campaign.budget.currency ||
          !Number.isFinite(scope.maxCost) ||
          scope.maxCost < 0 ||
          (scope.kind !== 'cost_settlement' && scope.maxCost > campaign.budget.limit) ||
          !Array.isArray(scope.artifactVersionIds) ||
          new Set(scope.artifactVersionIds).size !== scope.artifactVersionIds.length ||
          scope.artifactVersionIds.some(
            (id) => !campaign.artifactVersions.some((a) => a.id === id),
          ) ||
          (scope.kind === 'execution' &&
            (!scope.dispatchKey ||
              !scope.taskRevisionId ||
              !derivedCampaign.taskRevisions.some(
                (t) => t.id === scope.taskRevisionId && t.status !== 'stale',
              ))) ||
          (scope.kind === 'cli_preparation' &&
            (!scope.dispatchKey ||
              !scope.taskRevisionId ||
              !scope.configHash ||
              !SHA256.test(scope.configHash) ||
              !cliPreparation ||
              cliPreparation.configHash !== cliPreparationConfigHash(cliPreparation) ||
              scopedTask?.status === 'stale' ||
              scopedTask?.inputHash !== cliPreparation.inputHash ||
              scope.backendPolicyHash !== cliPreparation.backendPolicyHash ||
              scope.preparationLimits?.maxRuntimeMs !== cliPreparation.maxRuntimeMs ||
              scope.preparationLimits?.cpu !== 1 ||
              scope.preparationLimits?.memoryMb !== 256 ||
              scope.preparationLimits?.adapterConfigHash !== cliPreparation.adapterConfigHash ||
              scope.preparationLimits?.acknowledgeUnknownCost !== true)) ||
          (scope.kind === 'cost_settlement' &&
            (!costEvidence ||
              !validCostSubject(campaign, scope.costSubject) ||
              canonicalJson(scope.costSubject) !== canonicalJson(costEvidence.subject) ||
              scope.costEvidenceId !== costEvidence.id ||
              scope.costEvidenceHash !== digest(canonicalJson(costEvidence)) ||
              scope.costSubjectLabel !== costSubjectLabel(campaign, costEvidence.subject) ||
              scope.costResearchTitle !== campaign.goal ||
              scope.costDescription !== costEvidence.description ||
              scope.costAmount !== costEvidence.amount ||
              scope.maxCost !== costEvidence.amount ||
              scope.currency !== costEvidence.currency ||
              scope.artifactVersionIds.length !== 0 ||
              (campaign.costSettlements ?? []).some(
                (settlement) =>
                  settlement.evidenceId === costEvidence.id ||
                  costSubjectKey(settlement.subject) === costSubjectKey(costEvidence.subject),
              ))) ||
          (scope.kind === 'controller' &&
            (!scope.configHash ||
              !SHA256.test(scope.configHash) ||
              !validControllerLimits(scope.controllerLimits) ||
              scope.maxCost <= 0 ||
              scope.maxCost > campaign.budget.limit ||
              scope.maxRequests !== undefined ||
              scope.maxOutputTokens !== undefined)) ||
          (['formal_code_review', 'formal_execution'].includes(scope.kind) &&
            (!scope.formalPlanHash ||
              !SHA256.test(scope.formalPlanHash) ||
              textError(scope.formalEvaluatorId, 'formalEvaluatorId') ||
              !validFormalResources(scope.formalResources) ||
              scope.artifactVersionIds.length !== 1 ||
              !campaign.artifactVersions.some(
                (artifact) => artifact.id === scope.artifactVersionIds[0],
              ) ||
              (scope.kind === 'formal_code_review' &&
                (scope.maxCost <= 0 || !scope.configHash || !SHA256.test(scope.configHash)))))
        )
          return invalid(
            'invalid_approval_scope',
            'Approval requires current scope, budget and expiry',
          )
      }
      const approval: HumanApproval = {
        id:
          (typeof command.approvalId === 'string' && command.approvalId.trim()) || randomId('hap'),
        ...(command.scope ? { scope: cloneJson(command.scope) } : {}),
        bundleHash: campaign.bundleHash,
        reviewerId: command.reviewer.reviewerId.trim(),
        reviewerProofId: command.reviewer.proofId.trim(),
        reviewedAt: command.reviewer.verifiedAt,
        status: 'active',
        revokedAt: null,
        revokedByReviewerId: null,
        invalidatedAt: null,
      }
      if (campaign.approvals.some((existing) => existing.id === approval.id)) {
        return invalid('duplicate_approval', 'approvalId 已存在')
      }
      next = { ...campaign, approvals: [...campaign.approvals, approval] }
      break
    }
    case 'release': {
      if (campaign.pattern) {
        const derived = withDerivedTaskStatuses(campaign)
        const ids = campaign.pattern.taskRevisionIds
        if (
          ids.length !== 2 ||
          ids.some(
            (id) => !derived.taskRevisions.some((t) => t.id === id && t.status === 'verified'),
          )
        )
          return invalid(
            'pattern_review_required',
            'Pattern release requires current completed steps',
          )
      }
      const approval = campaign.approvals.find((a) => a.id === command.approvalId)
      if (
        !approval ||
        approval.status !== 'active' ||
        approval.bundleHash !== campaign.bundleHash ||
        approval.consumedBy ||
        approval.scope?.kind !== 'release' ||
        approval.scope.expiresAt <= now ||
        !Array.isArray(command.artifactVersionIds) ||
        command.artifactVersionIds.length === 0 ||
        new Set(command.artifactVersionIds).size !== command.artifactVersionIds.length ||
        canonicalJson([...command.artifactVersionIds].sort()) !==
          canonicalJson([...approval.scope.artifactVersionIds].sort()) ||
        command.artifactVersionIds.some(
          (artifactVersionId) => !hasExactReleasableArtifact(campaign, artifactVersionId),
        ) ||
        !hasSupportedReleaseReview(campaign, command.artifactVersionIds)
      )
        return invalid(
          'approval_required',
          'Release requires approved verified current artifacts and a supported evidence map',
        )
      next = {
        ...campaign,
        stage: 'output',
        status: 'completed',
        approvals: campaign.approvals.map((a) =>
          a.id === approval.id ? { ...a, consumedBy: `release:${campaign.version + 1}` } : a,
        ),
      }
      break
    }
    case 'revokeApproval': {
      const error = textError(command.approvalId, 'approvalId') ?? validateProof(command.reviewer)
      if (error) return invalid('invalid_revocation', error)
      const found = campaign.approvals.find((approval) => approval.id === command.approvalId)
      if (!found) return invalid('unknown_approval', '找不到 approvalId')
      if (found.status !== 'active' && !(found.status === 'invalidated' && found.consumedBy))
        return invalid('inactive_approval', '该审批已经失效或撤销')
      const consumedAttempt = found.consumedBy
        ? campaign.attempts.find((attempt) => attempt.id === found.consumedBy)
        : undefined
      const cliPreparationAttempt = consumedAttempt
        ? (campaign.cliPreparations ?? []).some(
            (preparation) => preparation.attemptId === consumedAttempt.id,
          )
        : false
      const control = progressControl(campaign)
      const stopsController =
        control.mode === 'bounded' && found.consumedBy === `controller:${control.reservationRef}`
      next = {
        ...campaign,
        ...(stopsController
          ? {
              progressControl: {
                ...control,
                state: 'held' as const,
                generation: control.generation + 1,
              },
              controllerReservations: (campaign.controllerReservations ?? []).map((item) =>
                item.id === control.reservationRef && item.status === 'active'
                  ? { ...item, status: 'held' as const }
                  : item,
              ),
            }
          : {}),
        approvals: campaign.approvals.map((approval) =>
          approval.id === found.id
            ? {
                ...approval,
                status: 'revoked',
                revokedAt: command.reviewer.verifiedAt,
                revokedByReviewerId: command.reviewer.reviewerId.trim(),
              }
            : approval,
        ),
        attempts:
          consumedAttempt &&
          cliPreparationAttempt &&
          ['running', 'unknown'].includes(consumedAttempt.status) &&
          consumedAttempt.cancelRequestedAt === null
            ? campaign.attempts.map((attempt) =>
                attempt.id === consumedAttempt.id
                  ? { ...attempt, cancelRequestedAt: now }
                  : attempt,
              )
            : campaign.attempts,
      }
      break
    }
    case 'declareSyntheticTask': {
      const templateId = command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE
      if (!isResearchTemplateId(templateId))
        return invalid('invalid_template', 'unknown fixed synthetic template')
      if (
        textError(command.taskId, 'taskId') ||
        !SHA256.test(command.inputHash) ||
        !Array.isArray(command.artifactVersionIds) ||
        command.artifactVersionIds.length > 100 ||
        new Set(command.artifactVersionIds).size !== command.artifactVersionIds.length ||
        command.artifactVersionIds.some(
          (id) =>
            typeof id !== 'string' ||
            !campaign.artifactVersions.some((artifact) => artifact.id === id),
        )
      )
        return invalid('invalid_task_spec', '任务必须绑定有效的确切输入产物版本')
      if (
        command.labelSetContentHashes !== undefined &&
        (!Array.isArray(command.labelSetContentHashes) ||
          new Set(command.labelSetContentHashes).size !== command.labelSetContentHashes.length ||
          command.labelSetContentHashes.some(
            (hash) => !(campaign.labelSets ?? []).some((ref) => ref.contentHash === hash),
          ))
      )
        return invalid(
          'invalid_labelset_dependency',
          'Task must bind exact admitted LabelSet versions',
        )
      const siblings = campaign.taskRevisions.filter((task) => task.taskId === command.taskId)
      const previous = siblings.toSorted((a, b) => b.revision - a.revision)[0]
      if (previous?.id !== command.previousRevisionId)
        return invalid('task_revision_conflict', '修订必须指定当前最新任务版本')
      const task: ResearchTaskRevision = {
        id: randomId('rtr'),
        taskId: command.taskId,
        ...(command.labelSetContentHashes
          ? { labelSetContentHashes: [...command.labelSetContentHashes].sort() }
          : {}),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous ? { previousRevisionId: previous.id } : {}),
        sourceContextVersion: 2,
        sourceContextHash: scientificContextHash(campaign, 2),
        ...(command.skillBinding ? { skillBinding: cloneJson(command.skillBinding) } : {}),
        artifactVersionIds: [...command.artifactVersionIds].sort(),
        stage: 'execution',
        templateId,
        stageId: templateId === SYNTHETIC_SUMMARY_TEMPLATE ? 'smoke' : 'evaluation',
        inputHash: command.inputHash,
        outputContract: templateId,
        dataClass: 'synthetic',
        status: 'pending',
        createdAt: now,
      }
      next = { ...campaign, taskRevisions: [...campaign.taskRevisions, task] }
      break
    }
    case 'claimSynthetic': {
      if (progressControl(campaign).state === 'held')
        return invalid('progress_held', 'Manual hold blocks new execution claims')
      if (
        (command.backend === 'ssh-daemon' &&
          (!command.backendPolicyHash || !SHA256.test(command.backendPolicyHash))) ||
        (command.backendPolicyHash !== undefined && command.backend !== 'ssh-daemon')
      )
        return invalid('invalid_backend_policy', 'SSH execution requires a pinned transport policy')
      if (
        command.trackingPolicyHash !== undefined &&
        (!['localhost-daemon', 'ssh-daemon'].includes(command.backend ?? '') ||
          !SHA256.test(command.trackingPolicyHash))
      )
        return invalid('invalid_tracking_policy', 'Tracking must bind a daemon source policy')
      const templateId = command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE
      if (!isResearchTemplateId(templateId))
        return invalid('invalid_template', 'unknown fixed synthetic template')
      const error =
        textError(command.dispatchKey, 'dispatchKey') ??
        (!SHA256.test(command.inputHash) ? 'inputHash 必须是 sha256: 后接 64 位小写十六进制' : null)
      if (error) return invalid('invalid_synthetic_claim', error)
      const selected = command.taskRevisionId
        ? withDerivedTaskStatuses(campaign).taskRevisions.find(
            (task) => task.id === command.taskRevisionId,
          )
        : undefined
      if (
        campaign.pattern &&
        (!selected || !campaign.pattern.taskRevisionIds.includes(selected.id))
      )
        return invalid('pattern_task_required', 'Only an applied Pattern task can be dispatched')
      if (
        selected &&
        canonicalJson(selected.skillBinding ?? null) !== canonicalJson(command.skillBinding ?? null)
      )
        return invalid('skill_binding_conflict', '执行技能锁与任务规格不一致')
      if (
        command.taskRevisionId &&
        (!selected ||
          selected.status === 'stale' ||
          selected.inputHash !== command.inputHash ||
          selected.templateId !== templateId)
      )
        return invalid('stale_task_revision', '任务版本不存在、已失效或输入不匹配')
      if (
        selected &&
        campaign.attempts.some(
          (attempt) =>
            attempt.taskRevisionId === selected.id &&
            (attempt.status === 'running' || attempt.status === 'unknown'),
        )
      )
        return invalid('task_attempt_conflict', '该任务已有运行中的尝试')
      const approval = command.approvalId
        ? campaign.approvals.find((a) => a.id === command.approvalId)
        : undefined
      const patternIndex = selected
        ? (campaign.pattern?.taskRevisionIds.indexOf(selected.id) ?? -1)
        : -1
      if (
        patternIndex >= 0 &&
        (campaign.pattern!.plan.backend !== (command.backend ?? 'builtin-local') ||
          campaign
            .pattern!.taskRevisionIds.slice(0, patternIndex)
            .some(
              (id) =>
                !withDerivedTaskStatuses(campaign).taskRevisions.some(
                  (t) => t.id === id && t.status === 'verified',
                ),
            ))
      )
        return invalid(
          'pattern_dependency_required',
          'Pattern requires the pinned backend and verified predecessor steps',
        )
      if (
        command.requireApproval ||
        command.approvalId ||
        patternIndex >= 0 ||
        command.backend === 'ssh-daemon'
      ) {
        if (
          !approval ||
          approval.status !== 'active' ||
          approval.bundleHash !== campaign.bundleHash ||
          approval.consumedBy ||
          approval.scope?.kind !== 'execution' ||
          approval.scope.expiresAt <= now ||
          approval.scope.currency !== campaign.budget.currency ||
          approval.scope.maxCost < 0 ||
          approval.scope.taskRevisionId !== selected?.id ||
          approval.scope.dispatchKey !== command.dispatchKey ||
          approval.scope.trackingPolicyHash !== command.trackingPolicyHash ||
          approval.scope.backendPolicyHash !== command.backendPolicyHash ||
          canonicalJson([...approval.scope.artifactVersionIds].sort()) !==
            canonicalJson([...(selected?.artifactVersionIds ?? [])].sort())
        )
          return invalid(
            'approval_required',
            'Dispatch requires an active exact task, input, key, budget and expiry approval',
          )
      }
      const task: ResearchTaskRevision = selected ?? {
        id: randomId('rtr'),
        revision: 1,
        stage: 'execution',
        templateId,
        stageId: templateId === SYNTHETIC_SUMMARY_TEMPLATE ? 'smoke' : 'evaluation',
        inputHash: command.inputHash,
        outputContract: templateId,
        dataClass: 'synthetic',
        status: 'pending',
        createdAt: now,
        sourceContextVersion: 2,
        sourceContextHash: scientificContextHash(campaign, 2),
        artifactVersionIds: [],
        ...(command.skillBinding ? { skillBinding: cloneJson(command.skillBinding) } : {}),
      }
      const attempt: ResearchAttempt = {
        id: randomId('rat'),
        taskRevisionId: task.id,
        dispatchKey: command.dispatchKey.trim(),
        ...(command.trackingPolicyHash ? { trackingPolicyHash: command.trackingPolicyHash } : {}),
        ...(command.backendPolicyHash ? { backendPolicyHash: command.backendPolicyHash } : {}),
        ...(command.backend ? { backend: command.backend } : {}),
        ownerPid: process.pid,
        status: 'running',
        executionStartedAt: now,
        endedAt: null,
        artifactVersionId: null,
        error: null,
        cancelRequestedAt: null,
      }
      next = {
        ...campaign,
        taskRevisions: selected ? campaign.taskRevisions : [...campaign.taskRevisions, task],
        attempts: [...campaign.attempts, attempt],
        approvals: approval
          ? campaign.approvals.map((a) =>
              a.id === approval.id ? { ...a, consumedBy: attempt.id } : a,
            )
          : campaign.approvals,
      }
      break
    }
    case 'bindSyntheticJob': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      const task = campaign.taskRevisions.find((t) => t.id === owned.attempt.taskRevisionId)
      const spec = command.spec
      if (
        !['localhost-daemon', 'ssh-daemon'].includes(owned.attempt.backend ?? '') ||
        owned.attempt.jobSpec ||
        !spec ||
        (spec.version !== 1 && spec.version !== 2) ||
        (spec.version === 1 && spec.execution !== undefined) ||
        (spec.version === 2 &&
          (task?.templateId !== 'supervised-phantom-v2' ||
            spec.execution?.adapter !== 'supervised-phantom-v2' ||
            spec.execution.codeHash !== task.skillBinding?.sourceHash ||
            spec.execution.maxRuntimeMs !== 600_000)) ||
        (spec.trackingPolicyHash !== undefined && !SHA256.test(spec.trackingPolicyHash)) ||
        spec.trackingPolicyHash !== owned.attempt.trackingPolicyHash ||
        spec.backendPolicyHash !== owned.attempt.backendPolicyHash ||
        spec.campaignId !== campaign.id ||
        spec.taskRevisionId !== task?.id ||
        spec.dispatchKey !== owned.attempt.id ||
        spec.templateId !== task.templateId ||
        spec.inputHash !== task.inputHash ||
        spec.resource?.cpu !== 1 ||
        spec.resource.memoryMb !== 256 ||
        !Number.isSafeInteger(spec.lease?.fence) ||
        spec.lease.fence < 1 ||
        spec.lease.expiresAt <= now ||
        textError(spec.lease.token, 'lease token')
      )
        return invalid(
          'invalid_job_binding',
          'Job must bind the fixed claimed task and resource lease',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === owned.attempt.id
            ? { ...a, jobSpec: cloneJson(spec), jobSpecHash: digest(canonicalJson(spec)) }
            : a,
        ),
      }
      break
    }
    case 'markSyntheticUnknown': {
      const attempt = attemptById(campaign, command.attemptId)
      if (
        !attempt ||
        !['localhost-daemon', 'ssh-daemon'].includes(attempt.backend ?? '') ||
        !['running', 'unknown'].includes(attempt.status) ||
        !currentCliObserver(attempt, command.observer, now)
      )
        return invalid(
          'invalid_unknown_transition',
          'Only an unresolved daemon attempt may become unknown',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === attempt.id
            ? { ...a, status: 'unknown', error: command.reason, endedAt: null }
            : a,
        ),
      }
      break
    }
    case 'resumeSyntheticObservation': {
      const attempt = attemptById(campaign, command.attemptId)
      if (
        !attempt ||
        !['localhost-daemon', 'ssh-daemon'].includes(attempt.backend ?? '') ||
        !['running', 'unknown'].includes(attempt.status) ||
        command.jobSpecHash !== (attempt.cliPreparationJobSpecHash ?? attempt.jobSpecHash) ||
        (!attempt.cliPreparationJobSpec && !attempt.jobSpec) ||
        !currentCliObserver(attempt, command.observer, now) ||
        (!attempt.cliPreparationAuthority &&
          attempt.ownerPid !== process.pid &&
          ownerAlive(attempt.ownerPid))
      )
        return invalid(
          'invalid_job_observation',
          'Observation must bind an unresolved job with no other live owner',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === attempt.id ? { ...a, status: 'running', ownerPid: process.pid, error: null } : a,
        ),
      }
      break
    }
    case 'finishSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      if (owned.attempt.cancelRequestedAt !== null) {
        return invalid('cancel_requested', '已请求取消的尝试不能提交完成结果')
      }
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === owned.attempt.taskRevisionId,
      )
      if (
        !task ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        !isResearchTemplateId(task.templateId) ||
        task.dataClass !== 'synthetic'
      ) {
        return invalid('invalid_synthetic_task', '尝试没有可执行的合成任务规格')
      }
      const validation = command.validation
      const error =
        (!SHA256.test(command.contentHash)
          ? 'contentHash 必须是 sha256: 后接 64 位小写十六进制'
          : null) ??
        textError(command.uri, 'uri') ??
        textError(command.artifactKind, 'artifactKind') ??
        (command.artifactKind !== task.outputContract ? 'Artifact contract mismatch' : null) ??
        (!validation || typeof validation !== 'object'
          ? 'validation 必须来自 runner 的字节核验'
          : null) ??
        (!SHA256.test(validation?.inputHash ?? '') || validation?.inputHash !== task.inputHash
          ? 'validation.inputHash 与当前任务输入不一致'
          : null) ??
        (!SHA256.test(validation?.contentHash ?? '') ||
        validation?.contentHash !== command.contentHash
          ? 'validation.contentHash 与定稿内容不一致'
          : null) ??
        (!Number.isSafeInteger(validation?.byteLength) || (validation?.byteLength ?? -1) < 0
          ? 'validation.byteLength 必须是非负整数'
          : null) ??
        (!Number.isSafeInteger(validation?.verifiedAt) || (validation?.verifiedAt ?? 0) <= 0
          ? 'validation.verifiedAt 必须是正整数时间戳'
          : null)
      if (error) return invalid('invalid_synthetic_finish', error)
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId: task.id,
        mediaType: 'application/json',
        dataClass: 'synthetic',
        inputArtifactVersionIds: [...(task.artifactVersionIds ?? [])],
        schemaId: task.outputContract,
        validation: cloneJson(validation),
        producerAttemptId: owned.attempt.id,
        producerTaskRevisionId: task.id,
        version:
          Math.max(
            0,
            ...campaign.artifactVersions
              .filter((item) => item.artifactId === task.id)
              .map((item) => item.version),
          ) + 1,
        uri: command.uri.trim(),
        kind: command.artifactKind.trim(),
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: 'completed',
                endedAt: now,
                artifactVersionId: artifact.id,
              }
            : attempt,
        ),
      }
      break
    }
    case 'failSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId, command.observer, now)
      if (!owned.ok) return owned
      const error = textError(command.error, 'error')
      if (error) return invalid('invalid_synthetic_failure', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: attempt.cancelRequestedAt === null ? 'failed' : 'cancelled',
                endedAt: now,
                error: command.error.trim(),
              }
            : attempt,
        ),
      }
      break
    }
    case 'requestCancelSynthetic': {
      const attempt = attemptById(campaign, command.attemptId)
      if (!attempt) return invalid('unknown_attempt', '找不到 attemptId')
      if (attempt.status !== 'running' && attempt.status !== 'unknown')
        return invalid('inactive_attempt', '该尝试已结束')
      if (attempt.cancelRequestedAt !== null)
        return invalid('cancel_requested', '该尝试已经请求取消')
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id ? { ...candidate, cancelRequestedAt: now } : candidate,
        ),
      }
      break
    }
    case 'interruptSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId, command.observer, now)
      if (!owned.ok) return owned
      const error = textError(command.reason, 'reason')
      if (error) return invalid('invalid_synthetic_interrupt', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: attempt.cancelRequestedAt === null ? 'interrupted' : 'cancelled',
                endedAt: now,
                error: command.reason.trim(),
              }
            : attempt,
        ),
      }
      break
    }
    case 'recoverSynthetic': {
      const attempt = attemptById(campaign, command.attemptId)
      if (!attempt) return invalid('unknown_attempt', '找不到 attemptId')
      if (attempt.status !== 'running' || !currentCliObserver(attempt, command.observer, now))
        return invalid('inactive_attempt', '该尝试已结束或观察租约已失效')
      const error = textError(command.reason, 'reason')
      if (error) return invalid('invalid_synthetic_recovery', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id
            ? {
                ...candidate,
                status: candidate.cancelRequestedAt === null ? 'interrupted' : 'cancelled',
                endedAt: now,
                error: command.reason.trim(),
              }
            : candidate,
        ),
      }
      break
    }
    default:
      return invalid('invalid_command', '不支持的 research command')
  }

  const versioned = { ...next, version: campaign.version + 1, updatedAt: now }
  const hashed = { ...versioned, bundleHash: bundleHash(versioned) }
  return { ok: true, campaign: withDerivedTaskStatuses(invalidateChangedApprovals(hashed, now)) }
}

function append(
  store: Store,
  event: ResearchEvent,
  idempotencyKey?: string,
  payloadHash?: string,
): void {
  store.db
    .query(
      `INSERT INTO research_events
       (id, campaign_id, sequence, event_type, command, campaign, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.campaignId,
      event.sequence,
      event.type,
      event.command === null ? null : JSON.stringify(event.command),
      JSON.stringify(event.campaign),
      event.occurredAt,
    )
  store.db
    .query(
      `INSERT INTO research_outbox (id, event_id, topic, payload, created_at, delivered_at)
       VALUES (?, ?, 'research.campaign.changed', ?, ?, NULL)`,
    )
    .run(randomId('rob'), event.id, JSON.stringify(event), event.occurredAt)
  if (idempotencyKey && payloadHash) {
    store.db
      .query(
        `INSERT INTO research_idempotency
         (campaign_id, idempotency_key, payload_hash, event_id, result_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.campaignId,
        idempotencyKey,
        payloadHash,
        event.id,
        JSON.stringify(event.campaign),
        event.occurredAt,
      )
  }
}

export function createResearchCampaign(
  store: Store,
  input: ResearchCampaignInput,
): ResearchWriteResult {
  const error = validInput(input)
  if (error) return invalid('invalid_campaign', error)
  const idempotencyKey = input.idempotencyKey.trim()
  const workspaceId = input.workspaceId.trim()
  const parentConversationId = input.parentConversationId.trim()
  const goal = input.goal.trim()
  const payloadHash = digest(
    canonicalJson({
      workspaceId,
      parentConversationId,
      goal,
      policy: input.policy,
      inputs: input.inputs,
      budget: input.budget,
    }),
  )
  return store.tx(() => {
    const known = store.db
      .query<IdempotencyRow, [string, string, string]>(
        `SELECT payload_hash, event_id, result_snapshot FROM research_create_idempotency
         WHERE workspace_id = ? AND parent_conversation_id = ? AND idempotency_key = ?`,
      )
      .get(workspaceId, parentConversationId, idempotencyKey)
    if (known) {
      if (known.payload_hash !== payloadHash) {
        return invalid('idempotency_conflict', '同一个 idempotencyKey 不能复用到不同请求')
      }
      const campaign = normalizeCampaign(JSON.parse(known.result_snapshot) as ResearchCampaign)
      const event = listResearchEvents(store, campaign.id).find(
        (candidate) => candidate.id === known.event_id,
      )
      if (!event) throw new Error(`research campaign ${campaign.id} has no create result event`)
      return { ok: true, campaign, event, replayed: true }
    }
    const parent = store.db
      .query<{ workspace_id: string }, [string]>(
        'SELECT workspace_id FROM conversations WHERE id = ?',
      )
      .get(parentConversationId)
    if (!parent) return invalid('unknown_parent_conversation', 'parentConversationId 不存在')
    if (parent.workspace_id !== workspaceId) {
      return invalid('parent_workspace_mismatch', 'parentConversationId 不属于 workspaceId')
    }
    const now = Date.now()
    const draft: ResearchCampaign = {
      id: randomId('rc'),
      workspaceId,
      parentConversationId,
      goal,
      stage: 'question',
      status: 'proposal',
      version: 1,
      policy: cloneJson(input.policy),
      inputs: cloneJson(input.inputs),
      budget: cloneJson(input.budget),
      artifactVersions: [],
      approvals: [],
      taskRevisions: [],
      attempts: [],
      bundleHash: '',
      createdAt: now,
      updatedAt: now,
    }
    const campaign = { ...draft, bundleHash: bundleHash(draft) }
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId: campaign.id,
      sequence: 1,
      type: 'created',
      command: null,
      campaign,
      occurredAt: now,
    }
    store.db
      .query(
        `INSERT INTO research_campaigns
         (id, workspace_id, parent_conversation_id, version, snapshot, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.id,
        campaign.workspaceId,
        campaign.parentConversationId,
        campaign.version,
        JSON.stringify(campaign),
        now,
      )
    append(store, event)
    store.db
      .query(
        `INSERT INTO research_create_idempotency
         (workspace_id, parent_conversation_id, idempotency_key, payload_hash, event_id, result_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.workspaceId,
        campaign.parentConversationId,
        idempotencyKey,
        payloadHash,
        event.id,
        JSON.stringify(campaign),
        now,
      )
    return { ok: true, campaign, event, replayed: false }
  })
}

export function getResearchCampaign(store: Store, id: string): ResearchCampaign | null {
  return current(store, id)
}

export function listResearchCampaigns(
  store: Store,
  workspaceId: string,
  parentConversationId?: string,
): ResearchCampaign[] {
  const rows = parentConversationId
    ? store.db
        .query<CampaignRow, [string, string]>(
          `SELECT snapshot FROM research_campaigns
           WHERE workspace_id = ? AND parent_conversation_id = ? ORDER BY updated_at DESC`,
        )
        .all(workspaceId, parentConversationId)
    : store.db
        .query<CampaignRow, [string]>(
          'SELECT snapshot FROM research_campaigns WHERE workspace_id = ? ORDER BY updated_at DESC',
        )
        .all(workspaceId)
  return rows.map((row) => normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign))
}

export function mutateResearchCampaign(
  store: Store,
  id: string,
  mutation: ResearchMutation,
): ResearchWriteResult {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    return invalid('invalid_mutation', 'mutation 必须是对象')
  }
  const campaignIdError = textError(id, 'campaignId')
  if (campaignIdError) return invalid('invalid_campaign_id', campaignIdError)
  const key = textError(mutation.idempotencyKey, 'idempotencyKey')
  if (key) return invalid('invalid_idempotency_key', key)
  const idempotencyKey = mutation.idempotencyKey.trim()
  if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) {
    return invalid('invalid_expected_version', 'expectedVersion 必须是正整数')
  }
  const malformed = commandError(mutation.command)
  if (malformed) return invalid('invalid_command', malformed)
  const stableCommand = (command: ResearchCommand) => {
    if (
      (command.kind === 'approve' ||
        command.kind === 'revokeApproval' ||
        command.kind === 'recordLabelSet' ||
        command.kind === 'recordFormalCodeReview') &&
      command.reviewer
    ) {
      const { verifiedAt: _observedAt, ...identity } = command.reviewer
      return { ...command, reviewer: identity }
    }
    return command
  }
  const payloadHash = digest(
    canonicalJson({
      expectedVersion: mutation.expectedVersion,
      command: stableCommand(mutation.command),
    }),
  )
  return store.tx(() => {
    const known = store.db
      .query<IdempotencyRow, [string, string]>(
        `SELECT payload_hash, result_snapshot FROM research_idempotency
         WHERE campaign_id = ? AND idempotency_key = ?`,
      )
      .get(id, idempotencyKey)
    if (known) {
      const campaign = normalizeCampaign(JSON.parse(known.result_snapshot) as ResearchCampaign)
      const event = listResearchEvents(store, id).find(
        (candidate) => candidate.sequence === campaign.version,
      )
      if (!event) throw new Error(`research campaign ${id} has no idempotent result event`)
      if (
        known.payload_hash !== payloadHash &&
        (!event.command ||
          !['approve', 'revokeApproval', 'recordLabelSet'].includes(event.command.kind) ||
          digest(
            canonicalJson({
              expectedVersion: event.sequence - 1,
              command: stableCommand(event.command),
            }),
          ) !== payloadHash)
      )
        return invalid(
          'idempotency_conflict',
          'Same idempotency key cannot identify different requests',
        )

      return { ok: true, campaign, event, replayed: true }
    }

    const campaign = current(store, id)
    if (!campaign) return invalid('not_found', '找不到 research campaign')
    if (mutation.command.kind === 'claimSynthetic') {
      if (textError(mutation.command.dispatchKey, 'dispatchKey')) {
        return invalid('invalid_synthetic_claim', 'dispatchKey 必须是非空字符串')
      }
      const dispatchKey = mutation.command.dispatchKey.trim()
      const existing = campaign.attempts.find((attempt) => attempt.dispatchKey === dispatchKey)
      if (existing) {
        const task = campaign.taskRevisions.find(
          (candidate) => candidate.id === existing.taskRevisionId,
        )
        if (
          !task ||
          task.inputHash !== mutation.command.inputHash ||
          task.templateId !== (mutation.command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE) ||
          canonicalJson(task.skillBinding ?? null) !==
            canonicalJson(mutation.command.skillBinding ?? null) ||
          (mutation.command.taskRevisionId !== undefined &&
            mutation.command.taskRevisionId !== task.id)
        ) {
          return invalid('dispatch_key_conflict', '同一个 dispatchKey 已绑定另一份输入')
        }
        const event = listResearchEvents(store, id).find(
          (candidate) =>
            candidate.command?.kind === 'claimSynthetic' &&
            candidate.command.dispatchKey.trim() === dispatchKey,
        )
        if (!event) throw new Error(`research campaign ${id} has no claim event for ${dispatchKey}`)
        return { ok: true, campaign, event, replayed: true }
      }
    }
    if (
      mutation.command.kind === 'approve' ||
      mutation.command.kind === 'revokeApproval' ||
      mutation.command.kind === 'recordLabelSet'
    ) {
      const proofId = mutation.command.reviewer?.proofId
      if (
        typeof proofId === 'string' &&
        store.db
          .query(
            "SELECT 1 FROM research_events WHERE json_extract(command, '$.reviewer.proofId') = ? LIMIT 1",
          )
          .get(proofId)
      )
        return invalid('replayed_human_proof', 'Human proof has already been consumed')
    }
    if (campaign.version !== mutation.expectedVersion) {
      return invalid('stale_version', `campaign 版本已经是 ${campaign.version}`)
    }
    const built = nextCampaign(campaign, mutation.command, Date.now())
    if (!built.ok) return built
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId: id,
      sequence: built.campaign.version,
      type: mutation.command.kind,
      command: cloneJson(mutation.command),
      campaign: built.campaign,
      occurredAt: built.campaign.updatedAt,
    }
    const update = store.db
      .query(
        `UPDATE research_campaigns SET version = ?, snapshot = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        event.sequence,
        JSON.stringify(built.campaign),
        event.occurredAt,
        id,
        mutation.expectedVersion,
      )
    if (update.changes !== 1) return invalid('stale_version', 'campaign 已被另一位写入者更新')
    append(store, event, idempotencyKey, payloadHash)
    return { ok: true, campaign: built.campaign, event, replayed: false }
  })
}

export function listResearchEvents(store: Store, campaignId: string): ResearchEvent[] {
  return store.db
    .query<EventRow, [string]>(
      `SELECT id, campaign_id, sequence, event_type, command, campaign, occurred_at
       FROM research_events WHERE campaign_id = ? ORDER BY sequence`,
    )
    .all(campaignId)
    .map(eventOf)
}

export function findRunningSyntheticAttempts(store: Store): ResearchRunningAttempt[] {
  const campaigns = store.db
    .query<CampaignRow, []>('SELECT snapshot FROM research_campaigns')
    .all()
    .map((row) => normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign))
  return campaigns.flatMap((campaign) =>
    campaign.attempts
      .filter((attempt) => attempt.status === 'running')
      .flatMap((attempt) => {
        const taskRevision = campaign.taskRevisions.find(
          (task) => task.id === attempt.taskRevisionId,
        )
        return taskRevision ? [{ campaignId: campaign.id, taskRevision, attempt }] : []
      }),
  )
}

function ownerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function recoverAttempt(store: Store, campaignId: string, attemptId: string): ResearchWriteResult {
  return store.tx(() => {
    const campaign = current(store, campaignId)
    if (!campaign) return invalid('not_found', '找不到 research campaign')
    const built = nextCampaign(
      campaign,
      {
        kind: 'recoverSynthetic',
        attemptId,
        reason: '执行进程已退出，恢复时终结悬挂尝试',
      },
      Date.now(),
    )
    if (!built.ok) return built
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId,
      sequence: built.campaign.version,
      type: 'recoverSynthetic',
      command: {
        kind: 'recoverSynthetic',
        attemptId,
        reason: '执行进程已退出，恢复时终结悬挂尝试',
      },
      campaign: built.campaign,
      occurredAt: built.campaign.updatedAt,
    }
    const update = store.db
      .query(
        `UPDATE research_campaigns SET version = ?, snapshot = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        event.sequence,
        JSON.stringify(built.campaign),
        event.occurredAt,
        campaignId,
        campaign.version,
      )
    if (update.changes !== 1) return invalid('stale_version', 'campaign 已被另一位写入者更新')
    append(store, event)
    return { ok: true, campaign: built.campaign, event, replayed: false }
  })
}

/** Only dead owners are recovered; a live process keeps exclusive control of its attempt. */
export function recoverRunningSyntheticAttempts(
  store: Store,
  options: RecoverSyntheticAttemptsOptions = {},
): ResearchAttempt[] {
  const isOwnerAlive = options.isOwnerAlive ?? ownerAlive
  const recovered: ResearchAttempt[] = []
  for (const running of findRunningSyntheticAttempts(store)) {
    if (isOwnerAlive(running.attempt.ownerPid)) continue
    const result = ['localhost-daemon', 'ssh-daemon'].includes(running.attempt.backend ?? '')
      ? mutateResearchCampaign(store, running.campaignId, {
          expectedVersion: getResearchCampaign(store, running.campaignId)!.version,
          idempotencyKey: `daemon-owner-lost:${running.attempt.id}`,
          command: {
            kind: 'markSyntheticUnknown',
            attemptId: running.attempt.id,
            reason: 'Daemon job requires explicit observation after owner exit',
          },
        })
      : recoverAttempt(store, running.campaignId, running.attempt.id)
    if (!result.ok) continue
    const attempt = result.campaign.attempts.find(
      (candidate) => candidate.id === running.attempt.id,
    )
    if (attempt) recovered.push(attempt)
  }
  return recovered
}

/** Rebuilds the mutable projection from the append-only campaign event ledger. */
export function rebuildResearchCampaignProjection(
  store: Store,
  campaignId: string,
): ResearchCampaign | null {
  return store.tx(() => {
    const campaign = foldResearchEvents(listResearchEvents(store, campaignId))
    if (!campaign) return null
    store.db
      .query(
        `INSERT INTO research_campaigns
         (id, workspace_id, parent_conversation_id, version, snapshot, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           parent_conversation_id = excluded.parent_conversation_id,
           version = excluded.version,
           snapshot = excluded.snapshot,
           updated_at = excluded.updated_at`,
      )
      .run(
        campaign.id,
        campaign.workspaceId,
        campaign.parentConversationId,
        campaign.version,
        JSON.stringify(campaign),
        campaign.updatedAt,
      )
    return campaign
  })
}
