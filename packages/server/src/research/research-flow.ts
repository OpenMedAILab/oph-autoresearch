import type {
  ArtifactVersion,
  ResearchCampaign,
  ResearchTaskRevision,
} from '@oph-autoresearch/core'
import { parseModelReview } from './review-contract.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const FLOW_SCHEMA = 'research-flow-v2' as const
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
  validatorHash: string
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
  readableTitle: string
  explanation: string
  nextActions: readonly ResearchFlowAction[]
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
    validatorHash: sha256(
      canonicalJson({ handler, inputSlots, outputSchema, schema: 'validator-v1' }),
    ),
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
  return campaign.taskRevisions
    .filter((task) => task.stageId === node)
    .toSorted((left, right) => right.revision - left.revision)[0]
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
  readableTitle: string,
  explanation: string,
  nextActions: readonly ResearchFlowAction[] = [],
): ResearchFlowProjectionNode {
  return Object.freeze({
    id,
    state,
    freshness,
    readableTitle,
    explanation,
    nextActions: Object.freeze([...nextActions]),
  })
}
function studyCurrent(campaign: ResearchCampaign) {
  return campaign.artifactVersions.some(
    (artifact) =>
      artifact.artifactId === 'document-study' &&
      artifact.kind === 'research-document-study' &&
      latestArtifact(campaign, artifact),
  )
}
function activeApproval(campaign: ResearchCampaign, kind: 'model_review' | 'release', now: number) {
  return campaign.approvals.some(
    (approval) =>
      approval.status === 'active' &&
      !approval.consumedBy &&
      approval.bundleHash === campaign.bundleHash &&
      approval.scope?.kind === kind &&
      approval.scope.expiresAt > now,
  )
}
function reviewState(campaign: ResearchCampaign, evaluation: ArtifactVersion | null) {
  const reviews = campaign.modelReviews ?? []
  const active = reviews.find((review) =>
    ['reserved', 'running', 'unknown'].includes(review.status),
  )
  if (active)
    return { kind: 'in_flight' as const, supported: false, reasons: ['独立复核仍在进行或状态未知'] }
  const done = reviews.find((review) => review.status === 'done')
  if (!done)
    return { kind: 'missing' as const, supported: false, reasons: ['尚无完成的独立证据复核'] }
  if (
    done.sourceValidity !== 'current' ||
    !evaluation ||
    !done.artifactVersionIds.includes(evaluation.id)
  )
    return {
      kind: 'stale' as const,
      supported: false,
      reasons: ['复核引用的证据已失效或不匹配当前评估'],
    }
  try {
    const map = parseModelReview(done.text ?? '', done.artifactVersionIds)
    if (map.decision !== 'supported')
      return {
        kind: 'insufficient' as const,
        supported: false,
        reasons: ['独立复核结论为证据不足'],
      }
    return { kind: 'supported' as const, supported: true, reasons: [] }
  } catch {
    return {
      kind: 'invalid' as const,
      supported: false,
      reasons: ['独立复核未通过声明—证据映射校验'],
    }
  }
}

/**
 * Pure campaign projection. It neither mutates the ledger nor launches a runner,
 * creates an approval request, or treats a candidate artifact as scientific evidence.
 */
export function projectResearchFlow(
  campaign: ResearchCampaign,
  input: unknown = { patternId: PATTERN_ID },
  now = campaign.updatedAt,
): ResearchFlowProjection {
  const flow = compileResearchFlow(input)
  const study = studyCurrent(campaign)
  const studyNode = study
    ? projected(campaign, 'study', 'satisfied', 'current', '研究问题与方案', '已记录当前研究方案。')
    : projected(
        campaign,
        'study',
        'ready',
        'current',
        '研究问题与方案',
        '需要先记录可核验的研究问题、PICO 和方案。',
        [
          action(
            campaign,
            'study',
            'record_study',
            'synthetic-study-v1/研究方案',
            ['缺少当前研究方案文档'],
            '记录研究方案',
          ),
        ],
      )

  const executionNode = (id: 'experiment' | 'evaluation', title: string, priorReady: boolean) => {
    const task = nodeTask(campaign, id)
    const candidatePresent = (campaign.cliPreparations ?? []).some(
      (preparation) => preparation.status === 'candidate' && preparation.artifactVersionId !== null,
    )
    if (!priorReady)
      return projected(campaign, id, 'blocked', 'current', title, '需要先满足前置流程节点。')
    if (!task) {
      const reasons = [
        'research-pattern-v2 仅提供结构投影，尚未接入此执行入口',
        ...(candidatePresent ? ['候选代码不是实验或评估证据'] : []),
      ]
      return projected(campaign, id, 'blocked', 'current', title, reasons.join('；'), [
        action(
          campaign,
          id,
          'prepare_execution_contract',
          `synthetic-study-v1/${id}`,
          reasons,
          '完善受控执行规格',
        ),
      ])
    }
    const active = campaign.attempts.find(
      (attempt) =>
        attempt.taskRevisionId === task.id && ['running', 'unknown'].includes(attempt.status),
    )
    if (active) {
      const unknown = active.status === 'unknown'
      const reasons = [unknown ? '尝试状态未知，仍占用该任务' : '尝试正在运行']
      return projected(
        campaign,
        id,
        'in_flight',
        task.status === 'stale' ? 'stale' : 'current',
        title,
        unknown ? '状态未知时只允许观察或请求取消，不能重派。' : '等待当前尝试形成可验证结果。',
        [
          action(
            campaign,
            id,
            'observe_attempt',
            `synthetic-study-v1/${id}`,
            reasons,
            '观察当前尝试',
          ),
          ...(unknown
            ? [
                action(
                  campaign,
                  id,
                  'cancel_attempt',
                  `synthetic-study-v1/${id}`,
                  reasons,
                  '请求取消未知尝试',
                ),
              ]
            : []),
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
        title,
        task.status === 'stale'
          ? '任务或其依赖已失效，需要重新冻结。'
          : '候选代码、未验证产物或不匹配的完成尝试不能作为科学证据。',
        [
          action(
            campaign,
            id,
            'inspect_evidence',
            `synthetic-study-v1/${id}`,
            [task.status === 'stale' ? '任务已失效' : '缺少当前已验证的科学产物'],
            '检查证据绑定',
          ),
        ],
      )
    return projected(campaign, id, 'satisfied', 'current', title, '存在当前且已验证的科学产物。')
  }

  const experiment = executionNode('experiment', '合成实验', study)
  const evaluation = executionNode('evaluation', '合成评估', experiment.state === 'satisfied')
  const evaluationTask = nodeTask(campaign, 'evaluation')
  const evaluationArtifact = evaluationTask
    ? currentScientificArtifact(campaign, evaluationTask)
    : null
  const review = reviewState(campaign, evaluationArtifact)
  const reviewNode =
    evaluation.state !== 'satisfied'
      ? projected(
          campaign,
          'review',
          'blocked',
          evaluation.freshness,
          '独立复核',
          '需要当前评估证据。',
        )
      : review.kind === 'supported'
        ? projected(
            campaign,
            'review',
            'satisfied',
            'current',
            '独立复核',
            '当前复核支持其声明—证据映射。',
          )
        : review.kind === 'in_flight'
          ? projected(
              campaign,
              'review',
              'in_flight',
              'current',
              '独立复核',
              '复核尚未形成可采纳结论。',
              [
                action(
                  campaign,
                  'review',
                  'observe_attempt',
                  'synthetic-study-v1/独立复核',
                  review.reasons,
                  '观察独立复核',
                ),
              ],
            )
          : review.kind === 'missing' && !activeApproval(campaign, 'model_review', now)
            ? projected(
                campaign,
                'review',
                'waiting_human',
                'current',
                '独立复核',
                '需要人类针对当前证据范围作出独立复核审批。',
                [
                  action(
                    campaign,
                    'review',
                    'request_human_approval',
                    'synthetic-study-v1/独立复核',
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
          '结果发布',
          '账本已记录完成的发布事实。',
        )
      : !review.supported
        ? projected(
            campaign,
            'release',
            'blocked',
            reviewNode.freshness,
            '结果发布',
            '证据不足或复核不当前，不能发布。',
          )
        : !activeApproval(campaign, 'release', now)
          ? projected(
              campaign,
              'release',
              'waiting_human',
              'current',
              '结果发布',
              '需要人类对当前已验证产物作出精确发布审批。',
              [
                action(
                  campaign,
                  'release',
                  'request_human_approval',
                  'synthetic-study-v1/结果发布',
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
