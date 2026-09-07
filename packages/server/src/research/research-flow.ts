import type {
  ArtifactVersion,
  ResearchCampaign,
  ResearchTaskRevision,
} from '@oph-autoresearch/core'
import { hasSupportedReleaseReview } from '@oph-autoresearch/store'
import { parseModelReview } from './review-contract.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const FLOW_SCHEMA = 'research-pattern-v2' as const
const PATTERN_ID = 'synthetic-study-v1' as const
type GateKind = 'none' | 'human_approval'
type NodeRole =
  | 'study_designer'
  | 'experiment_runner'
  | 'evaluator'
  | 'independent_reviewer'
  | 'release_reviewer'
type FlowHandler =
  | 'record_research_study'
  | 'synthetic_study_experiment'
  | 'synthetic_study_evaluation'
  | 'independent_evidence_review'
  | 'release_verified_findings'

export interface ResearchFlowNode {
  id: 'study' | 'experiment' | 'evaluation' | 'review' | 'release'
  role: NodeRole
  handler: FlowHandler
  dependsOn: readonly string[]
  inputSlots: readonly string[]
  outputSchema: string
  /** No validator implementation exists yet, so no source hash is claimed. */
  validatorHash: null
  validationCapability: 'planned'
  gateKind: GateKind
  /** This compiler describes a future bounded route; it does not register one. */
  executionCapability: 'planned'
}

export interface CompiledResearchFlow {
  schema: typeof FLOW_SCHEMA
  patternId: typeof PATTERN_ID
  contractHash: string
  nodes: readonly ResearchFlowNode[]
}

export interface ResearchFlowAction {
  actionKey: string
  op:
    | 'record_study'
    | 'prepare_execution_contract'
    | 'request_human_approval'
    | 'observe_attempt'
    | 'cancel_attempt'
    | 'inspect_evidence'
  subjectRef: string
  expectedVersion: number
  dependencyHash: string
  reasons: readonly string[]
  readableTitle: string
}

export interface ResearchFlowProjectionNode {
  id: ResearchFlowNode['id']
  state: 'blocked' | 'ready' | 'waiting_human' | 'in_flight' | 'satisfied'
  freshness: 'current' | 'stale'
  /** Existing fixed-template facts are mapped separately from this planned v2 node. */
  legacyEvidence: 'none' | 'current_receipt_mapping' | 'stale_receipt_mapping'
  readableTitle: string
  explanation: string
  nextActions: readonly ResearchFlowAction[]
}

/**
 * API code may pass verified document reads from readResearchDocuments. Omission
 * intentionally means no document is trusted by this pure projection.
 */
export interface ProjectionEvidenceInput {
  documents?: readonly {
    id: string
    kind: string
    contentHash: string
    verified: boolean
    stale: boolean
  }[]
}

export interface ResearchFlowProjection {
  schema: 'research-flow-projection-v1'
  patternId: typeof PATTERN_ID
  contractHash: string
  campaignVersion: number
  nodes: readonly ResearchFlowProjectionNode[]
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function staticNode(
  id: ResearchFlowNode['id'],
  role: NodeRole,
  handler: FlowHandler,
  dependsOn: readonly string[],
  inputSlots: readonly string[],
  outputSchema: string,
  gateKind: GateKind,
): ResearchFlowNode {
  return Object.freeze({
    id,
    role,
    handler,
    dependsOn: Object.freeze([...dependsOn]),
    inputSlots: Object.freeze([...inputSlots]),
    outputSchema,
    validatorHash: null,
    validationCapability: 'planned' as const,
    gateKind,
    executionCapability: 'planned' as const,
  })
}

const SYNTHETIC_STUDY_NODES = Object.freeze([
  staticNode(
    'study',
    'study_designer',
    'record_research_study',
    [],
    ['campaign_goal', 'public_metadata_citations'],
    'research-study-document-v1',
    'none',
  ),
  staticNode(
    'experiment',
    'experiment_runner',
    'synthetic_study_experiment',
    ['study'],
    ['current_study', 'validated_synthetic_inputs'],
    'synthetic-study-experiment-receipt-v1',
    'human_approval',
  ),
  staticNode(
    'evaluation',
    'evaluator',
    'synthetic_study_evaluation',
    ['experiment'],
    ['current_experiment_receipt'],
    'synthetic-study-evaluation-report-v1',
    'human_approval',
  ),
  staticNode(
    'review',
    'independent_reviewer',
    'independent_evidence_review',
    ['evaluation'],
    ['current_evaluation_report'],
    'claim-evidence-map-v1',
    'human_approval',
  ),
  staticNode(
    'release',
    'release_reviewer',
    'release_verified_findings',
    ['review'],
    ['supported_claim_evidence_map'],
    'research-release-record-v1',
    'human_approval',
  ),
] satisfies readonly ResearchFlowNode[])

/** Server whitelist only. Caller input selects a named pattern; it never supplies a handler or tool. */
export function compileResearchFlow(input: unknown): CompiledResearchFlow {
  if (!record(input) || !exact(input, ['patternId']) || input.patternId !== PATTERN_ID)
    throw new Error('invalid research flow pattern')
  const plan = { schema: FLOW_SCHEMA, patternId: PATTERN_ID, nodes: SYNTHETIC_STUDY_NODES }
  return Object.freeze({ ...plan, contractHash: sha256(canonicalJson(plan)) })
}

function latestArtifact(campaign: ResearchCampaign, artifact: ArtifactVersion) {
  return !campaign.artifactVersions.some(
    (candidate) =>
      candidate.artifactId === artifact.artifactId && candidate.version > artifact.version,
  )
}
function currentScientificArtifact(
  campaign: ResearchCampaign,
  task: ResearchTaskRevision,
): ArtifactVersion | null {
  const attempt = campaign.attempts.find(
    (candidate) =>
      candidate.taskRevisionId === task.id &&
      candidate.status === 'completed' &&
      candidate.artifactVersionId !== null,
  )
  const artifact = attempt?.artifactVersionId
    ? campaign.artifactVersions.find((candidate) => candidate.id === attempt.artifactVersionId)
    : undefined
  if (
    !attempt ||
    !artifact ||
    !artifact.validation ||
    artifact.validation.inputHash !== task.inputHash ||
    artifact.validation.contentHash !== artifact.contentHash ||
    !latestArtifact(campaign, artifact) ||
    artifact.producerAttemptId !== attempt.id ||
    artifact.producerTaskRevisionId !== task.id ||
    artifact.kind === 'cli_preparation_candidate'
  )
    return null
  return artifact
}
function nodeTask(campaign: ResearchCampaign, node: 'experiment' | 'evaluation') {
  const latest = (stageId: 'experiment' | 'evaluation') =>
    campaign.taskRevisions
      .filter((task) => task.stageId === stageId)
      .toSorted((left, right) => right.revision - left.revision)[0]
  const direct = latest(node)
  if (direct) return { task: direct, legacyEvidence: 'current_receipt_mapping' as const }
  // The current ledger has fixed synthetic evaluation receipts, not a distinct
  // experiment stage. Map that existing fact visibly; never claim it ran v2.
  const legacy = node === 'experiment' ? latest('evaluation') : undefined
  return legacy
    ? { task: legacy, legacyEvidence: 'current_receipt_mapping' as const }
    : { task: undefined, legacyEvidence: 'none' as const }
}
function dependencyHash(campaign: ResearchCampaign, node: string, reasons: readonly string[]) {
  return sha256(
    canonicalJson({ bundleHash: campaign.bundleHash, node, reasons, version: campaign.version }),
  )
}
function action(
  campaign: ResearchCampaign,
  node: string,
  op: ResearchFlowAction['op'],
  subjectRef: string,
  reasons: readonly string[],
  readableTitle: string,
): ResearchFlowAction {
  const hash = dependencyHash(campaign, node, reasons)
  return {
    actionKey: `research-flow:${node}:${op}:${hash.slice(7, 23)}`,
    op,
    subjectRef,
    expectedVersion: campaign.version,
    dependencyHash: hash,
    reasons: Object.freeze([...reasons]),
    readableTitle,
  }
}
function projected(
  _campaign: ResearchCampaign,
  id: ResearchFlowNode['id'],
  state: ResearchFlowProjectionNode['state'],
  freshness: ResearchFlowProjectionNode['freshness'],
  legacyEvidence: ResearchFlowProjectionNode['legacyEvidence'],
  readableTitle: string,
  explanation: string,
  nextActions: readonly ResearchFlowAction[] = [],
): ResearchFlowProjectionNode {
  return Object.freeze({
    id,
    state,
    freshness,
    legacyEvidence,
    readableTitle,
    explanation,
    nextActions: Object.freeze([...nextActions]),
  })
}
function studyCurrent(campaign: ResearchCampaign, evidence: ProjectionEvidenceInput) {
  return (evidence.documents ?? []).some((document) => {
    if (document.kind !== 'study' || !document.verified || document.stale) return false
    const artifact = campaign.artifactVersions.find((candidate) => candidate.id === document.id)
    return (
      artifact?.artifactId === 'document-study' &&
      artifact.kind === 'research-document-study' &&
      artifact.contentHash === document.contentHash &&
      latestArtifact(campaign, artifact)
    )
  })
}
function activeApproval(
  campaign: ResearchCampaign,
  kind: 'model_review' | 'release',
  now: number,
  artifactIds: readonly string[],
) {
  return campaign.approvals.some(
    (approval) =>
      approval.status === 'active' &&
      !approval.consumedBy &&
      approval.bundleHash === campaign.bundleHash &&
      approval.scope?.kind === kind &&
      canonicalJson([...approval.scope.artifactVersionIds].sort()) ===
        canonicalJson([...artifactIds].sort()) &&
      approval.scope.expiresAt > now,
  )
}
function currentArtifactById(campaign: ResearchCampaign, id: string) {
  const artifact = campaign.artifactVersions.find((candidate) => candidate.id === id)
  const task = artifact?.producerTaskRevisionId
    ? campaign.taskRevisions.find((candidate) => candidate.id === artifact.producerTaskRevisionId)
    : undefined
  return artifact && task && currentScientificArtifact(campaign, task)?.id === artifact.id
    ? artifact
    : null
}
function reviewState(campaign: ResearchCampaign, evaluation: ArtifactVersion | null) {
  const reviews = campaign.modelReviews ?? []
  const active = reviews.find((review) =>
    ['reserved', 'running', 'unknown'].includes(review.status),
  )
  if (active)
    return { kind: 'in_flight' as const, supported: false, reasons: ['独立复核仍在进行或状态未知'] }
  const completed = reviews.filter((review) => review.status === 'done')
  if (completed.length === 0)
    return { kind: 'missing' as const, supported: false, reasons: ['尚无完成的独立证据复核'] }
  let insufficient = false
  let stale = false
  for (const review of completed) {
    if (
      review.sourceValidity !== 'current' ||
      !evaluation ||
      !review.text ||
      review.contentHash !== sha256(review.text) ||
      !review.artifactVersionIds.includes(evaluation.id) ||
      review.artifactVersionIds.some((id) => !currentArtifactById(campaign, id))
    ) {
      stale = true
      continue
    }
    try {
      const map = parseModelReview(review.text, review.artifactVersionIds)
      if (!map.claims.some((claim) => claim.artifactVersionIds.includes(evaluation.id))) {
        continue
      }
      if (
        map.decision === 'supported' &&
        hasSupportedReleaseReview(campaign, review.artifactVersionIds)
      )
        return {
          kind: 'supported' as const,
          supported: true,
          reasons: [],
          artifactVersionIds: review.artifactVersionIds,
        }
      insufficient = true
    } catch {}
  }
  if (insufficient)
    return { kind: 'insufficient' as const, supported: false, reasons: ['独立复核结论为证据不足'] }
  if (stale)
    return {
      kind: 'stale' as const,
      supported: false,
      reasons: ['复核文本或引用证据已失效、不完整或已被篡改'],
    }
  return {
    kind: 'invalid' as const,
    supported: false,
    reasons: ['独立复核未覆盖当前评估声明—证据映射'],
  }
}

/**
 * Pure campaign projection. It neither mutates the ledger nor launches a runner,
 * creates an approval request, or treats a candidate artifact as scientific evidence.
 */
export function projectResearchFlow(
  campaign: ResearchCampaign,
  evidence: ProjectionEvidenceInput = {},
  now = campaign.updatedAt,
): ResearchFlowProjection {
  const flow = compileResearchFlow({ patternId: PATTERN_ID })
  const study = studyCurrent(campaign, evidence)
  const studyNode = study
    ? projected(
        campaign,
        'study',
        'satisfied',
        'current',
        'none',
        '研究问题与方案',
        '已核验当前研究方案。',
      )
    : projected(
        campaign,
        'study',
        'ready',
        'current',
        'none',
        '研究问题与方案',
        '需要先读取并核验当前的研究问题、PICO 和方案文档。',
        [
          action(
            campaign,
            'study',
            'record_study',
            '合成研究/研究方案',
            ['缺少经读取核验的当前研究方案文档'],
            '记录研究方案',
          ),
        ],
      )

  const executionNode = (id: 'experiment' | 'evaluation', title: string, priorReady: boolean) => {
    const match = nodeTask(campaign, id)
    const task = match.task
    const candidatePresent = (campaign.cliPreparations ?? []).some(
      (preparation) => preparation.status === 'candidate' && preparation.artifactVersionId !== null,
    )
    const legacyEvidence =
      match.legacyEvidence === 'current_receipt_mapping' && task?.status === 'stale'
        ? ('stale_receipt_mapping' as const)
        : match.legacyEvidence
    const active = campaign.attempts.find(
      (attempt) =>
        campaign.taskRevisions.some(
          (candidate) =>
            candidate.id === attempt.taskRevisionId &&
            (candidate.stageId === id ||
              (id === 'experiment' && candidate.stageId === 'evaluation')),
        ) && ['running', 'unknown'].includes(attempt.status),
    )
    if (active) {
      const unknown = active.status === 'unknown'
      const preparation = campaign.cliPreparations?.some((item) => item.attemptId === active.id)
      const reasons = [unknown ? '尝试状态未知，仍占用该任务' : '尝试正在运行']
      return projected(
        campaign,
        id,
        'in_flight',
        campaign.taskRevisions.find((candidate) => candidate.id === active.taskRevisionId)
          ?.status === 'stale'
          ? 'stale'
          : 'current',
        legacyEvidence,
        title,
        preparation
          ? unknown
            ? '代码准备状态待核对，只允许观察或请求取消；尚未执行正式实验。'
            : '代码准备进行中，完成后仅保存候选；尚未执行正式实验。'
          : unknown
            ? '状态未知时只允许观察或请求取消，不能重派。'
            : '等待当前尝试形成可验证结果。',
        [
          action(campaign, id, 'observe_attempt', `合成研究/${title}`, reasons, '观察当前尝试'),
          ...(unknown
            ? [
                action(
                  campaign,
                  id,
                  'cancel_attempt',
                  `合成研究/${title}`,
                  reasons,
                  '请求取消未知尝试',
                ),
              ]
            : []),
        ],
      )
    }
    if (!priorReady)
      return projected(
        campaign,
        id,
        'blocked',
        'current',
        legacyEvidence,
        title,
        '需要先满足前置流程节点。',
      )
    if (!task) {
      const reasons = [
        '该计划节点尚未接入受控执行入口',
        ...(candidatePresent ? ['候选代码不是实验或评估证据'] : []),
      ]
      return projected(
        campaign,
        id,
        'blocked',
        'current',
        legacyEvidence,
        title,
        reasons.join('；'),
        [
          action(
            campaign,
            id,
            'prepare_execution_contract',
            `合成研究/${title}`,
            reasons,
            '完善受控执行规格',
          ),
        ],
      )
    }
    const artifact = currentScientificArtifact(campaign, task)
    if (task.status === 'stale' || !artifact)
      return projected(
        campaign,
        id,
        'blocked',
        task.status === 'stale' ? 'stale' : 'current',
        legacyEvidence,
        title,
        task.status === 'stale'
          ? '任务或其依赖已失效，需要重新冻结。'
          : '候选代码、未验证产物或不匹配的完成尝试不能作为科学证据。',
        [
          action(
            campaign,
            id,
            'inspect_evidence',
            `合成研究/${title}`,
            [task.status === 'stale' ? '任务已失效' : '缺少当前已验证的科学产物'],
            '检查证据绑定',
          ),
        ],
      )
    return projected(
      campaign,
      id,
      'satisfied',
      'current',
      legacyEvidence,
      title,
      legacyEvidence === 'current_receipt_mapping'
        ? '已映射既有固定合成评估回执；这不是该计划节点已执行的声明。'
        : '存在当前且已验证的科学产物。',
    )
  }

  const experiment = executionNode('experiment', '合成实验', study)
  const evaluation = executionNode('evaluation', '合成评估', experiment.state === 'satisfied')
  const evaluationMatch = nodeTask(campaign, 'evaluation')
  const evaluationArtifact = evaluationMatch.task
    ? currentScientificArtifact(campaign, evaluationMatch.task)
    : null
  const review = reviewState(campaign, evaluationArtifact)
  const reviewLegacy = evaluation.legacyEvidence
  const reviewNode =
    evaluation.state !== 'satisfied'
      ? projected(
          campaign,
          'review',
          'blocked',
          evaluation.freshness,
          reviewLegacy,
          '独立复核',
          '需要当前评估证据。',
        )
      : review.kind === 'supported'
        ? projected(
            campaign,
            'review',
            'satisfied',
            'current',
            reviewLegacy,
            '独立复核',
            '当前复核支持其声明—证据映射。',
          )
        : review.kind === 'in_flight'
          ? projected(
              campaign,
              'review',
              'in_flight',
              'current',
              reviewLegacy,
              '独立复核',
              '复核尚未形成可采纳结论。',
              [
                action(
                  campaign,
                  'review',
                  'observe_attempt',
                  '合成研究/独立复核',
                  review.reasons,
                  '观察独立复核',
                ),
              ],
            )
          : review.kind === 'missing' &&
              !activeApproval(
                campaign,
                'model_review',
                now,
                evaluationArtifact ? [evaluationArtifact.id] : [],
              )
            ? projected(
                campaign,
                'review',
                'waiting_human',
                'current',
                reviewLegacy,
                '独立复核',
                '需要人类针对当前证据范围作出独立复核审批。',
                [
                  action(
                    campaign,
                    'review',
                    'request_human_approval',
                    '合成研究/独立复核',
                    review.reasons,
                    '请求独立复核审批',
                  ),
                ],
              )
            : projected(
                campaign,
                'review',
                'blocked',
                review.kind === 'stale' ? 'stale' : 'current',
                reviewLegacy,
                '独立复核',
                review.reasons.join('；'),
              )
  const releaseNode =
    campaign.status === 'completed' && review.supported && evaluation.state === 'satisfied'
      ? projected(
          campaign,
          'release',
          'satisfied',
          'current',
          reviewLegacy,
          '结果发布',
          '账本已记录完成的发布事实。',
        )
      : !review.supported
        ? projected(
            campaign,
            'release',
            'blocked',
            reviewNode.freshness,
            reviewLegacy,
            '结果发布',
            '证据不足或复核不当前，不能发布。',
          )
        : !activeApproval(
              campaign,
              'release',
              now,
              'artifactVersionIds' in review ? review.artifactVersionIds : [],
            )
          ? projected(
              campaign,
              'release',
              'waiting_human',
              'current',
              reviewLegacy,
              '结果发布',
              '需要人类对当前已验证产物作出精确发布审批。',
              [
                action(
                  campaign,
                  'release',
                  'request_human_approval',
                  '合成研究/结果发布',
                  ['缺少当前发布审批'],
                  '请求发布审批',
                ),
              ],
            )
          : projected(
              campaign,
              'release',
              'ready',
              'current',
              reviewLegacy,
              '结果发布',
              '审批条件已具备；该投影不会执行发布。',
            )
  return Object.freeze({
    schema: 'research-flow-projection-v1',
    patternId: PATTERN_ID,
    contractHash: flow.contractHash,
    campaignVersion: campaign.version,
    nodes: Object.freeze([studyNode, experiment, evaluation, reviewNode, releaseNode]),
  })
}
