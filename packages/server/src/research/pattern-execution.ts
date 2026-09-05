import type { ResearchCampaign, ResearchCommand, ResearchJsonObject } from '@oph-autoresearch/core'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { compileResearchPattern } from './pattern.ts'
import { sha256 } from './skill-lock.ts'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { type StartSyntheticRunInput, startSyntheticRun } from './synthetic-runner.ts'
import { fixedResearchTemplate } from './template-registry.ts'

export function applyResearchPattern(input: {
  store: Store
  campaignId: string
  expectedVersion: number
  idempotencyKey: string
  pattern: unknown
}) {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) throw new Error('Unknown campaign')
  const { contractHash, ...plan } = compileResearchPattern(input.pattern)
  if (
    plan.policy.currency !== campaign.budget.currency ||
    plan.policy.budget !== campaign.budget.limit
  )
    throw new Error('Pattern budget must match the current campaign budget')
  const templateId = plan.selection.selectedTemplateId
  const tasks = (templateId ? ['synthetic-summary-v1', templateId] : []).map(
    (id): Extract<ResearchCommand, { kind: 'declareSyntheticTask' }> => {
      const template = fixedResearchTemplate(id)
      return {
        kind: 'declareSyntheticTask',
        taskId: `pattern-${contractHash.slice(7, 23)}-${sha256(input.idempotencyKey).slice(7, 15)}-${id}`,
        templateId: template.id,
        inputHash: template.execute().inputHash,
        skillBinding: template.binding,
        artifactVersionIds: [],
      }
    },
  )
  return mutateResearchCampaign(input.store, campaign.id, {
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    command: {
      kind: 'applyResearchPattern',
      contractHash,
      plan: plan as unknown as ResearchJsonObject,
      tasks,
    },
  })
}

/** Stage evidence is derived; a plan node alone never implies execution or scientific acceptance. */
export function researchPatternStatus(campaign: ResearchCampaign) {
  const pattern = campaign.pattern
  if (!pattern) throw new Error('No applied Pattern')
  const tasks = pattern.taskRevisionIds.map(
    (id) => campaign.taskRevisions.find((task) => task.id === id)!,
  )
  if (tasks.some((task) => !task)) throw new Error('Pattern lineage missing')
  const [smoke, evaluation] = tasks
  const blocked = tasks.length === 0
  const stale = tasks.some((task) => task.status === 'stale')
  const review = campaign.modelReviews?.find(
    (review) =>
      review.status === 'done' &&
      review.sourceValidity === 'current' &&
      review.artifactVersionIds.some((id) =>
        campaign.artifactVersions.some(
          (a) => a.id === id && a.producerTaskRevisionId === evaluation?.id,
        ),
      ),
  )
  const complete = evaluation?.status === 'verified'
  const rows = [
    { stageId: 'question', status: 'recorded', evidence: campaign.goal },
    {
      stageId: 'literature',
      status: campaign.literatureCitations?.length ? 'metadata-recorded' : 'not-requested',
      evidence: `${campaign.literatureCitations?.length ?? 0} metadata citations; no full-text claim verification`,
    },
    {
      stageId: 'dataset_audit',
      status: 'fixed-fixture-contract',
      evidence: 'Synthetic fixture only; leakage checks execute inside the evaluation template',
    },
    {
      stageId: 'protocol_freeze',
      status: blocked ? 'criteria-unmet' : stale ? 'stale' : 'recorded',
      evidence: pattern.contractHash,
    },
    {
      stageId: 'smoke',
      status: blocked ? 'blocked' : (smoke?.status ?? 'pending'),
      evidence: smoke?.id ?? '',
    },
    {
      stageId: 'experiment',
      status: blocked ? 'blocked' : complete ? 'verified' : (evaluation?.status ?? 'pending'),
      evidence: `${evaluation?.id ?? ''}; fixed scorer pipeline, no classifier training`,
    },
    {
      stageId: 'evaluation',
      status: blocked ? 'blocked' : (evaluation?.status ?? 'pending'),
      evidence: evaluation?.id ?? '',
    },
    {
      stageId: 'independent_review',
      status: review ? 'model-reviewed' : 'pending',
      evidence:
        review?.id ??
        'Requires an approved evidence review; model output is not human or clinical acceptance',
    },
    {
      stageId: 'release',
      status: campaign.status === 'completed' && !stale ? 'released' : 'pending',
      evidence: 'Requires separate signed release approval',
    },
  ]
  const next =
    blocked || stale || tasks.some((task) => ['failed', 'interrupted'].includes(task.status))
      ? 'replan-required'
      : !complete
        ? 'approved-fixed-execution'
        : !review
          ? 'approved-model-review'
          : campaign.status === 'completed'
            ? 'complete'
            : 'signed-release'
  const nextTask = tasks.find((task) => task.status !== 'verified')
  return {
    contractHash: pattern.contractHash,
    stages: rows,
    nextAction: next,
    dispatchKey: nextTask ? `pattern-${pattern.contractHash.slice(7, 23)}-${nextTask.id}` : null,
    taskRevisionId: tasks.find((task) => task.status !== 'verified')?.id ?? null,
    adaptive: pattern.plan.selection,
    candidateAssessments: pattern.plan.candidateAssessments,
  }
}

/** One caller-authorized step only. Existing Runner owns approval, replay, slot and receipt semantics. */
export async function advanceResearchPattern(
  input: Omit<
    StartSyntheticRunInput,
    'dispatchKey' | 'templateId' | 'taskRevisionId' | 'requireApproval'
  >,
) {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign?.pattern) throw new Error('No applied Pattern')
  const state = researchPatternStatus(campaign)
  if (state.nextAction !== 'approved-fixed-execution' || !state.taskRevisionId)
    throw new Error('No fixed execution step is available')
  const task = campaign.taskRevisions.find((t) => t.id === state.taskRevisionId)!
  const backend = campaign.pattern.plan.backend
  if (
    backend !==
    (input.daemonBackend?.kind ?? (input.daemonBackend ? 'localhost-daemon' : 'builtin-local'))
  )
    throw new Error('Pattern backend does not match the configured Runner')
  // Before advancing past an earlier step, verify its actual persisted bytes again.
  for (const id of campaign.pattern.taskRevisionIds) {
    if (id === task.id) break
    const attempt = campaign.attempts.find(
      (a) => a.taskRevisionId === id && a.status === 'completed',
    )
    if (!attempt) throw new Error('Previous Pattern step has no verified evidence')
    await syntheticProtocol(input.store, input.workspaceRoot, campaign.id).receipt(attempt.id)
  }
  return startSyntheticRun({
    ...input,
    templateId: task.templateId,
    taskRevisionId: task.id,
    requireApproval: true,
    dispatchKey: `pattern-${campaign.pattern.contractHash.slice(7, 23)}-${task.id}`,
  })
}
