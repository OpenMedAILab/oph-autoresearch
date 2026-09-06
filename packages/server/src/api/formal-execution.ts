import {
  FORMAL_DATASET_TARGET,
  FORMAL_ENTRY_ARGV,
  FORMAL_EXECUTION_SCHEMA,
  FORMAL_OUTPUT_TARGET,
  type FormalCodeReviewResult,
  type FormalExecutionPlan,
  validFormalExecutionPlan,
} from '@oph-autoresearch/core'
import {
  formalExecutionPlanHash,
  getResearchCampaign,
  getWorkspace,
  mutateResearchCampaign,
} from '@oph-autoresearch/store'
import { readCliCandidateView } from '../research/cli-candidate-view.ts'
import { HUMAN_PROOF_HEADER } from '../research/human-auth.ts'
import { publishResearchEvents } from '../research-events.ts'
import { type ApiHandler, json } from './types.ts'

const SHA256 = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  const hash = new Bun.CryptoHasher('sha256')
  hash.update(value)
  return `sha256:${hash.digest('hex')}`
}

/** Hash only stable binding facts. The local root, SSH profile, and credentials never enter a plan. */
export function formalWorkspaceBindingHash(
  workspaceId: string,
  binding: { connectionHash: string; remoteRoot: string },
): string {
  return sha256(
    canonical({
      schema: 'research-formal-workspace-binding-v1',
      localWorkspaceId: workspaceId,
      profileConnectionHash: binding.connectionHash,
      remoteRoot: binding.remoteRoot,
    }),
  )
}

type PlanInput = {
  planId: string
  preparationId: string
  ociImageDigest: string
  dataManifestHash: string
  labelSetContentHash: string
  trustedEvaluatorId: string
  trustedEvaluatorHash: string
  maxRuntimeMs: number
  cpu: number
  memoryMb: number
  pidsLimit: number
}

function planInput(body: Record<string, unknown>): PlanInput | null {
  const keys = [
    'cpu',
    'dataManifestHash',
    'labelSetContentHash',
    'maxRuntimeMs',
    'memoryMb',
    'ociImageDigest',
    'pidsLimit',
    'planId',
    'preparationId',
    'trustedEvaluatorHash',
    'trustedEvaluatorId',
  ]
  if (Object.keys(body).sort().join(',') !== keys.join(',')) return null
  const strings = [
    'planId',
    'preparationId',
    'ociImageDigest',
    'dataManifestHash',
    'labelSetContentHash',
    'trustedEvaluatorId',
    'trustedEvaluatorHash',
  ] as const
  if (strings.some((key) => typeof body[key] !== 'string')) return null
  if (
    !ID.test(body.planId as string) ||
    !ID.test(body.preparationId as string) ||
    body.trustedEvaluatorId !== 'binary-classification-v1'
  )
    return null
  if (
    ![
      body.ociImageDigest,
      body.dataManifestHash,
      body.labelSetContentHash,
      body.trustedEvaluatorHash,
    ].every((value) => typeof value === 'string' && SHA256.test(value))
  )
    return null
  for (const key of ['maxRuntimeMs', 'cpu', 'memoryMb', 'pidsLimit'] as const) {
    if (!Number.isSafeInteger(body[key]) || (body[key] as number) <= 0) return null
  }
  return body as unknown as PlanInput
}

async function buildPlan(
  deps: Parameters<ApiHandler>[2],
  campaignId: string,
  input: PlanInput,
): Promise<{ plan: FormalExecutionPlan; code: string } | null> {
  const campaign = getResearchCampaign(deps.store, campaignId)
  const workspace = getWorkspace(deps.store, deps.workspaceId as never)
  const binding = workspace?.serverBinding
  if (
    !campaign ||
    !binding ||
    binding.version !== 1 ||
    !SHA256.test(binding.connectionHash) ||
    typeof binding.remoteRoot !== 'string' ||
    !binding.remoteRoot.startsWith('/')
  )
    return null
  const candidate = await readCliCandidateView(campaign, deps.workspaceRoot, input.preparationId)
  if (candidate.quarantined || !candidate.current) return null
  if (
    !(campaign.labelSets ?? []).some((item) => item.contentHash === input.labelSetContentHash) ||
    !deps.researchFormalEvaluators?.some(
      (item) =>
        item.id === input.trustedEvaluatorId &&
        item.implementationHash === input.trustedEvaluatorHash,
    )
  )
    return null
  const plan: FormalExecutionPlan = {
    schema: FORMAL_EXECUTION_SCHEMA,
    planId: input.planId,
    taskRevisionId: candidate.taskRevisionId,
    candidateArtifactId: candidate.candidateArtifactId,
    codeHash: candidate.codeHash,
    candidateReceiptHash: candidate.candidateReceiptHash,
    workspaceBindingHash: formalWorkspaceBindingHash(deps.workspaceId, binding),
    ociImageDigest: input.ociImageDigest,
    entryArgv: FORMAL_ENTRY_ARGV,
    dataManifestHash: input.dataManifestHash,
    labelSetContentHash: input.labelSetContentHash,
    trustedEvaluatorId: input.trustedEvaluatorId,
    trustedEvaluatorHash: input.trustedEvaluatorHash,
    resources: {
      maxRuntimeMs: input.maxRuntimeMs,
      cpu: input.cpu,
      memoryMb: input.memoryMb,
      pidsLimit: input.pidsLimit,
      network: 'disabled',
    },
    datasetMount: { target: FORMAL_DATASET_TARGET, readOnly: true },
    outputMount: { target: FORMAL_OUTPUT_TARGET },
  }
  if (!validFormalExecutionPlan(plan)) return null
  return { code: candidate.code, plan }
}

function result(response: ReturnType<typeof mutateResearchCampaign>) {
  return response.ok
    ? json(response)
    : json(response, response.code.includes('conflict') ? 409 : 400)
}

export const handleFormalExecutionApi: ApiHandler = async (url, request, deps) => {
  const match =
    /^\/api\/research\/campaigns\/([A-Za-z0-9_-]+)\/formal-execution(?:\/(quote|approval|review|human-review|freeze|submit))?$/.exec(
      url.pathname,
    )
  if (!match) return null
  const campaignId = match[1]!
  const action = match[2]
  const campaign = getResearchCampaign(deps.store, campaignId)
  if (!campaign || campaign.workspaceId !== deps.workspaceId)
    return json({ error: 'not_found' }, 404)
  if (request.method === 'GET' && !action) {
    return json({
      plans: campaign.formalExecutionPlans ?? [],
      reviews: campaign.formalCodeReviews ?? [],
      admittedBackend: false,
    })
  }
  if (request.method !== 'POST' || !action)
    return new Response('', { status: 405, headers: { allow: 'GET, POST' } })
  if (action === 'submit') {
    return json(
      {
        error: 'formal_execution_backend_unavailable',
        message: '尚无通过隔离验收的正式执行后端；冻结计划不能提交。',
      },
      409,
    )
  }
  const raw = await request.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return json({ error: 'invalid_request' }, 400)
  const body = raw as Record<string, unknown>
  const required = (keys: string[]) =>
    Object.keys(body).sort().join(',') === [...keys].sort().join(',')
  const baseKeys = [
    'planId',
    'preparationId',
    'ociImageDigest',
    'dataManifestHash',
    'labelSetContentHash',
    'trustedEvaluatorId',
    'trustedEvaluatorHash',
    'maxRuntimeMs',
    'cpu',
    'memoryMb',
    'pidsLimit',
  ]
  if (action === 'quote') {
    if (
      !required([...baseKeys, 'reviewMaxCost', 'expiresAt']) ||
      !Number.isFinite(body.reviewMaxCost) ||
      (body.reviewMaxCost as number) <= 0 ||
      !Number.isSafeInteger(body.expiresAt)
    )
      return json({ error: 'invalid_quote_request' }, 400)
    const parsedQuote = planInput(Object.fromEntries(baseKeys.map((key) => [key, body[key]])))
    if (!parsedQuote) return json({ error: 'invalid_plan_input' }, 400)
    const built = await buildPlan(deps, campaignId, parsedQuote).catch(() => null)
    if (!built) return json({ error: 'candidate_or_binding_unavailable' }, 409)
    const planHash = formalExecutionPlanHash(built.plan)
    return json({
      plan: built.plan,
      planHash,
      reviewApprovalScope: {
        kind: 'formal_code_review',
        formalPlanHash: planHash,
        formalEvaluatorId: built.plan.trustedEvaluatorId,
        formalResources: built.plan.resources,
        artifactVersionIds: [built.plan.candidateArtifactId],
        currency: campaign.budget.currency,
        maxCost: body.reviewMaxCost,
        expiresAt: body.expiresAt,
      },
    })
  }
  const planFields = Object.fromEntries(baseKeys.map((key) => [key, body[key]])) as Record<
    string,
    unknown
  >
  const parsed = planInput(planFields)
  if (!parsed) return json({ error: 'invalid_plan_input' }, 400)
  const built = await buildPlan(deps, campaignId, parsed).catch(() => null)
  if (!built) return json({ error: 'candidate_or_binding_unavailable' }, 409)
  if (action === 'approval') {
    if (
      !required([...baseKeys, 'executionMaxCost', 'expiresAt']) ||
      !Number.isFinite(body.executionMaxCost) ||
      (body.executionMaxCost as number) < 0 ||
      !Number.isSafeInteger(body.expiresAt)
    )
      return json({ error: 'invalid_execution_approval_request' }, 400)
    if (
      !(campaign.formalCodeReviews ?? []).some(
        (review) =>
          review.decision === 'accepted' &&
          review.candidateArtifactId === built.plan.candidateArtifactId &&
          review.taskRevisionId === built.plan.taskRevisionId &&
          review.codeHash === built.plan.codeHash &&
          review.candidateReceiptHash === built.plan.candidateReceiptHash &&
          review.workspaceBindingHash === built.plan.workspaceBindingHash &&
          review.ociImageDigest === built.plan.ociImageDigest &&
          review.dataManifestHash === built.plan.dataManifestHash &&
          review.labelSetContentHash === built.plan.labelSetContentHash &&
          review.trustedEvaluatorId === built.plan.trustedEvaluatorId &&
          review.trustedEvaluatorHash === built.plan.trustedEvaluatorHash,
      )
    )
      return json({ error: 'accepted_formal_review_required' }, 409)
    const planHash = formalExecutionPlanHash(built.plan)
    return json({
      plan: built.plan,
      planHash,
      formalExecutionApprovalScope: {
        kind: 'formal_execution',
        formalPlanHash: planHash,
        formalEvaluatorId: built.plan.trustedEvaluatorId,
        formalResources: built.plan.resources,
        artifactVersionIds: [built.plan.candidateArtifactId],
        currency: campaign.budget.currency,
        maxCost: body.executionMaxCost,
        expiresAt: body.expiresAt,
      },
    })
  }
  if (action === 'review') {
    if (
      !required([...baseKeys, 'approvalId', 'expectedVersion', 'idempotencyKey']) ||
      typeof body.approvalId !== 'string' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string'
    )
      return json({ error: 'invalid_review_request' }, 400)
    if (!deps.researchFormalCodeReviewer)
      return json({ error: 'isolated_reviewer_unavailable' }, 409)
    const reviewed = await deps.researchFormalCodeReviewer.review({
      code: built.code,
      plan: built.plan,
    })
    if (!SHA256.test(reviewed.runnerReceiptHash))
      return json({ error: 'untrusted_isolated_reviewer' }, 409)
    const formal: FormalCodeReviewResult = {
      schema: 'research-formal-code-review-v1',
      reviewId: `fcr_${crypto.randomUUID()}`,
      reviewKind: 'isolated-api',
      candidateArtifactId: built.plan.candidateArtifactId,
      taskRevisionId: built.plan.taskRevisionId,
      codeHash: built.plan.codeHash,
      candidateReceiptHash: built.plan.candidateReceiptHash,
      workspaceBindingHash: built.plan.workspaceBindingHash,
      ociImageDigest: built.plan.ociImageDigest,
      dataManifestHash: built.plan.dataManifestHash,
      labelSetContentHash: built.plan.labelSetContentHash,
      trustedEvaluatorId: built.plan.trustedEvaluatorId,
      trustedEvaluatorHash: built.plan.trustedEvaluatorHash,
      decision: reviewed.decision,
      findings: reviewed.findings,
      reviewedAt: Date.now(),
      reviewerId: reviewed.reviewerId,
      runnerReceiptHash: reviewed.runnerReceiptHash,
    }
    const written = mutateResearchCampaign(deps.store, campaignId, {
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: body.idempotencyKey as string,
      command: {
        kind: 'recordFormalCodeReview',
        plan: built.plan,
        result: formal,
        approvalId: body.approvalId,
      },
    })
    if (written.ok && !written.replayed)
      publishResearchEvents(deps.store, deps.bus, deps.researchNotifications)
    return result(written)
  }
  if (action === 'human-review') {
    if (
      !required([
        ...baseKeys,
        'decision',
        'findings',
        'reviewId',
        'expectedVersion',
        'idempotencyKey',
      ]) ||
      !deps.researchHumanAuth ||
      !Number.isSafeInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string' ||
      !ID.test(String(body.reviewId))
    )
      return json({ error: 'invalid_human_review_request' }, 400)
    const proof = deps.researchHumanAuth({
      header: request.headers.get(HUMAN_PROOF_HEADER),
      workspaceId: deps.workspaceId,
      campaignId,
      action: 'formal_review',
      body,
    })
    if (!proof) return json({ error: 'human_proof_required' }, 403)
    const formal: FormalCodeReviewResult = {
      schema: 'research-formal-code-review-v1',
      reviewId: body.reviewId as string,
      reviewKind: 'human-signed',
      candidateArtifactId: built.plan.candidateArtifactId,
      taskRevisionId: built.plan.taskRevisionId,
      codeHash: built.plan.codeHash,
      candidateReceiptHash: built.plan.candidateReceiptHash,
      workspaceBindingHash: built.plan.workspaceBindingHash,
      ociImageDigest: built.plan.ociImageDigest,
      dataManifestHash: built.plan.dataManifestHash,
      labelSetContentHash: built.plan.labelSetContentHash,
      trustedEvaluatorId: built.plan.trustedEvaluatorId,
      trustedEvaluatorHash: built.plan.trustedEvaluatorHash,
      decision: body.decision as FormalCodeReviewResult['decision'],
      findings: body.findings as FormalCodeReviewResult['findings'],
      reviewedAt: proof.verifiedAt,
      reviewerId: proof.reviewerId,
    }
    const written = mutateResearchCampaign(deps.store, campaignId, {
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: body.idempotencyKey as string,
      command: {
        kind: 'recordFormalCodeReview',
        plan: built.plan,
        result: formal,
        reviewer: proof,
      },
    })
    if (written.ok && !written.replayed)
      publishResearchEvents(deps.store, deps.bus, deps.researchNotifications)
    return result(written)
  }
  if (action === 'freeze') {
    if (
      !required([...baseKeys, 'approvalId', 'expectedVersion', 'idempotencyKey']) ||
      typeof body.approvalId !== 'string' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string'
    )
      return json({ error: 'invalid_freeze_request' }, 400)
    const written = mutateResearchCampaign(deps.store, campaignId, {
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: body.idempotencyKey as string,
      command: {
        kind: 'freezeFormalExecutionPlan',
        plan: built.plan,
        planHash: formalExecutionPlanHash(built.plan),
        approvalId: body.approvalId as string,
      },
    })
    if (written.ok && !written.replayed)
      publishResearchEvents(deps.store, deps.bus, deps.researchNotifications)
    return result(written)
  }
  return json({ error: 'method_not_allowed' }, 405)
}
