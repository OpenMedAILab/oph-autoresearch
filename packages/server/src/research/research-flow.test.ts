import { expect, test } from 'bun:test'
import type {
  ArtifactVersion,
  ResearchCampaign,
  ResearchTaskRevision,
} from '@oph-autoresearch/core'
import { compileResearchPattern } from './pattern.ts'
import { compileResearchFlow, projectResearchFlow } from './research-flow.ts'

const hash = (label: string) =>
  `sha256:${new Bun.CryptoHasher('sha256').update(label).digest('hex')}`

function task(
  id: string,
  stageId: 'experiment' | 'evaluation',
  status: ResearchTaskRevision['status'],
  templateId: ResearchTaskRevision['templateId'] = 'synthetic-evaluation-v1',
): ResearchTaskRevision {
  return {
    id,
    revision: 1,
    taskId: id,
    stage: 'execution',
    stageId,
    templateId,
    inputHash: hash(`input-${id}`),
    outputContract: templateId,
    dataClass: 'synthetic',
    status,
    createdAt: 1,
    artifactVersionIds: [],
  }
}
function baseCampaign(): ResearchCampaign {
  return {
    id: 'campaign-flow',
    workspaceId: 'workspace-flow',
    parentConversationId: 'conversation-flow',
    goal: '验证合成研究流投影',
    stage: 'protocol',
    status: 'proposal',
    version: 7,
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
    artifactVersions: [],
    approvals: [],
    taskRevisions: [],
    attempts: [],
    bundleHash: hash('bundle'),
    createdAt: 1,
    updatedAt: 10,
  }
}
function studyArtifact(): ArtifactVersion {
  return {
    id: 'study-v1',
    artifactId: 'document-study',
    version: 1,
    uri: 'file:///study',
    kind: 'research-document-study',
    contentHash: hash('study'),
    createdAt: 1,
  }
}
function scientificEvidence(
  campaign: ResearchCampaign,
  flowTask: ResearchTaskRevision,
): ArtifactVersion {
  const attemptId = `attempt-${flowTask.id}`
  const artifact: ArtifactVersion = {
    id: `artifact-${flowTask.id}`,
    artifactId: `result-${flowTask.id}`,
    version: 1,
    uri: `file:///${flowTask.id}`,
    kind: 'synthetic-evaluation-report',
    contentHash: hash(`artifact-${flowTask.id}`),
    createdAt: 2,
    producerAttemptId: attemptId,
    producerTaskRevisionId: flowTask.id,
    validation: {
      inputHash: flowTask.inputHash,
      contentHash: hash(`artifact-${flowTask.id}`),
      byteLength: 12,
      verifiedAt: 2,
    },
  }
  campaign.artifactVersions.push(artifact)
  campaign.attempts.push({
    id: attemptId,
    taskRevisionId: flowTask.id,
    dispatchKey: `dispatch-${flowTask.id}`,
    ownerPid: 1,
    status: 'completed',
    executionStartedAt: 1,
    endedAt: 2,
    artifactVersionId: artifact.id,
    error: null,
    cancelRequestedAt: null,
  })
  return artifact
}
function verifiedDocuments(campaign: ResearchCampaign) {
  return campaign.artifactVersions
    .filter((artifact) => artifact.kind === 'research-document-study')
    .map((artifact) => ({
      id: artifact.id,
      kind: 'study' as const,
      contentHash: artifact.contentHash,
      verified: true,
      stale: false,
    }))
}
function node(
  campaign: ResearchCampaign,
  id: string,
  evidence = { documents: verifiedDocuments(campaign) },
) {
  return projectResearchFlow(campaign, evidence).nodes.find((candidate) => candidate.id === id)!
}

test('research-flow v2 compiles only the server whitelist and leaves v1 compilation unchanged', () => {
  const v1Input = {
    dataMode: 'scores' as const,
    backend: 'builtin-local' as const,
    policy: {
      syntheticOnly: true as const,
      allowPublicMetadata: false,
      maxModelRequests: 2 as const,
      currency: 'USD' as const,
      budget: 0,
    },
  }
  const v1Hash = compileResearchPattern(v1Input).contractHash
  const flow = compileResearchFlow({ patternId: 'synthetic-study-v1' })
  expect(flow).toMatchObject({ schema: 'research-pattern-v2', patternId: 'synthetic-study-v1' })
  expect(flow.nodes).toHaveLength(5)
  expect(flow.nodes.every((candidate) => candidate.executionCapability === 'planned')).toBe(true)
  expect(flow.nodes.map((candidate) => candidate.handler)).toEqual([
    'record_research_study',
    'synthetic_study_experiment',
    'synthetic_study_evaluation',
    'independent_evidence_review',
    'release_verified_findings',
  ])
  expect(
    flow.nodes.every(
      (candidate) =>
        candidate.validatorHash === null && candidate.validationCapability === 'planned',
    ),
  ).toBe(true)
  expect(() => compileResearchFlow({ patternId: 'synthetic-study-v1', handler: 'shell' })).toThrow(
    'invalid',
  )
  expect(() => compileResearchFlow({ patternId: 'other' })).toThrow('invalid')
  expect(compileResearchPattern(v1Input).contractHash).toBe(v1Hash)
})

test('projection is pure, uses no internal identifiers in actions, and makes only guidance available', () => {
  const campaign = baseCampaign()
  const before = structuredClone(campaign)
  const projection = projectResearchFlow(campaign, {})
  expect(projection.schema).toBe('research-flow-projection-v1')
  expect(campaign).toEqual(before)
  expect(node(campaign, 'study')).toMatchObject({ state: 'ready', freshness: 'current' })
  const action = node(campaign, 'study').nextActions[0]!
  expect(action).toMatchObject({
    op: 'record_study',
    expectedVersion: campaign.version,
    readableTitle: '记录研究方案',
  })
  expect(action.subjectRef).toBe('合成研究/研究方案')
  expect(JSON.stringify(action)).not.toContain(campaign.id)
})

test('unknown attempts occupy a flow node and permit observation or cancellation only', () => {
  const campaign = baseCampaign()
  campaign.artifactVersions.push(studyArtifact())
  const experiment = task('experiment-current', 'experiment', 'pending')
  campaign.taskRevisions.push(experiment)
  campaign.attempts.push({
    id: 'attempt-unknown',
    taskRevisionId: experiment.id,
    dispatchKey: 'unknown-dispatch',
    ownerPid: 1,
    status: 'unknown',
    executionStartedAt: 1,
    endedAt: null,
    artifactVersionId: null,
    error: null,
    cancelRequestedAt: null,
  })
  const projected = node(campaign, 'experiment')
  expect(projected.state).toBe('in_flight')
  expect(projected.nextActions.map((action) => action.op)).toEqual([
    'observe_attempt',
    'cancel_attempt',
  ])
  expect(projected.nextActions.some((action) => action.op === 'prepare_execution_contract')).toBe(
    false,
  )
})

test('candidate code never satisfies scientific evidence and insufficient review cannot release', () => {
  const candidateCampaign = baseCampaign()
  candidateCampaign.artifactVersions.push(studyArtifact())
  const candidateTask = task('candidate-experiment', 'experiment', 'verified')
  candidateCampaign.taskRevisions.push(candidateTask)
  const candidateArtifact: ArtifactVersion = {
    id: 'candidate-artifact',
    artifactId: 'candidate',
    version: 1,
    uri: 'file:///candidate',
    kind: 'cli_preparation_candidate',
    contentHash: hash('candidate'),
    createdAt: 2,
    producerAttemptId: 'candidate-attempt',
    producerTaskRevisionId: candidateTask.id,
    validation: {
      inputHash: candidateTask.inputHash,
      contentHash: hash('candidate'),
      byteLength: 8,
      verifiedAt: 2,
    },
  }
  candidateCampaign.artifactVersions.push(candidateArtifact)
  candidateCampaign.attempts.push({
    id: 'candidate-attempt',
    taskRevisionId: candidateTask.id,
    dispatchKey: 'candidate-dispatch',
    ownerPid: 1,
    status: 'completed',
    executionStartedAt: 1,
    endedAt: 2,
    artifactVersionId: candidateArtifact.id,
    error: null,
    cancelRequestedAt: null,
  })
  candidateCampaign.cliPreparations = [
    {
      id: 'prep',
      taskRevisionId: candidateTask.id,
      dispatchKey: 'prep-dispatch',
      candidateId: 'candidate',
      adapterId: 'adapter',
      adapterConfigHash: hash('adapter'),
      backendPolicyHash: hash('backend'),
      model: 'model',
      instructions: 'candidate only',
      inputHash: candidateTask.inputHash,
      configHash: hash('config'),
      deviceId: 'device',
      maxRuntimeMs: 1,
      maxCost: 1,
      acknowledgeUnknownCost: true,
      actualCost: null,
      status: 'candidate',
      attemptId: 'candidate-attempt',
      artifactVersionId: candidateArtifact.id,
      createdAt: 2,
    },
  ]
  expect(node(candidateCampaign, 'experiment')).toMatchObject({ state: 'blocked' })
  expect(node(candidateCampaign, 'experiment').explanation).toContain('候选代码')

  const reviewed = baseCampaign()
  reviewed.artifactVersions.push(studyArtifact())
  const experiment = task('scientific-experiment', 'experiment', 'verified')
  const evaluation = task('scientific-evaluation', 'evaluation', 'verified')
  reviewed.taskRevisions.push(experiment, evaluation)
  scientificEvidence(reviewed, experiment)
  const evaluationArtifact = scientificEvidence(reviewed, evaluation)
  const insufficientText = JSON.stringify({
    decision: 'insufficient',
    claims: [],
    limitations: ['证据不足'],
  })
  reviewed.modelReviews = [
    {
      id: 'review-insufficient',
      dispatchKey: 'review-dispatch',
      approvalId: 'approval',
      evidencePackHash: hash('pack'),
      configHash: hash('review-config'),
      artifactVersionIds: [evaluationArtifact.id],
      currency: 'USD',
      reservedCost: 0,
      maxRequests: 1,
      maxOutputTokens: 1,
      requestCount: 1,
      status: 'done',
      ownerPid: 1,
      sourceValidity: 'current',
      text: insufficientText,
      contentHash: hash(insufficientText),
      actualCost: null,
    },
  ]
  expect(node(reviewed, 'review')).toMatchObject({ state: 'blocked' })
  expect(node(reviewed, 'release')).toMatchObject({ state: 'blocked' })
  expect(node(reviewed, 'release').explanation).toContain('不能发布')
})

test('stale task evidence remains blocked and is surfaced as stale', () => {
  const campaign = baseCampaign()
  campaign.artifactVersions.push(studyArtifact())
  campaign.taskRevisions.push(task('stale-experiment', 'experiment', 'stale'))
  const projected = node(campaign, 'experiment')
  expect(projected).toMatchObject({ state: 'blocked', freshness: 'stale' })
  expect(projected.nextActions[0]).toMatchObject({ op: 'inspect_evidence' })
})

test('study satisfaction requires injected verified current document evidence', () => {
  const campaign = baseCampaign()
  const study = studyArtifact()
  campaign.artifactVersions.push(study)
  expect(
    node(campaign, 'study', {
      documents: [
        { id: study.id, kind: 'study', contentHash: hash('forged'), verified: true, stale: false },
      ],
    }).state,
  ).toBe('ready')
  expect(
    node(campaign, 'study', {
      documents: [
        {
          id: study.id,
          kind: 'study',
          contentHash: study.contentHash,
          verified: true,
          stale: true,
        },
      ],
    }).state,
  ).toBe('ready')
  expect(node(campaign, 'study', { documents: verifiedDocuments(campaign) }).state).toBe(
    'satisfied',
  )
})

test('expired or non-covering completed reviews cannot satisfy review or release', () => {
  const campaign = baseCampaign()
  campaign.artifactVersions.push(studyArtifact())
  const experiment = task('review-experiment', 'experiment', 'verified')
  const evaluation = task('review-evaluation', 'evaluation', 'verified')
  campaign.taskRevisions.push(experiment, evaluation)
  const experimentArtifact = scientificEvidence(campaign, experiment)
  const evaluationArtifact = scientificEvidence(campaign, evaluation)
  const supportingButNonCovering = JSON.stringify({
    decision: 'supported',
    claims: [{ claim: '只覆盖实验', artifactVersionIds: [experimentArtifact.id] }],
    limitations: [],
  })
  campaign.modelReviews = [
    {
      id: 'review-non-covering',
      dispatchKey: 'review',
      approvalId: 'approval',
      evidencePackHash: hash('pack'),
      configHash: hash('config'),
      artifactVersionIds: [experimentArtifact.id, evaluationArtifact.id],
      currency: 'USD',
      reservedCost: 0,
      maxRequests: 1,
      maxOutputTokens: 1,
      requestCount: 1,
      status: 'done',
      ownerPid: 1,
      sourceValidity: 'current',
      text: supportingButNonCovering,
      contentHash: hash(supportingButNonCovering),
      actualCost: null,
    },
  ]
  expect(node(campaign, 'review')).toMatchObject({ state: 'blocked' })
  expect(node(campaign, 'release')).toMatchObject({ state: 'blocked' })
  campaign.modelReviews[0] = { ...campaign.modelReviews[0]!, sourceValidity: 'stale' }
  expect(node(campaign, 'review')).toMatchObject({ state: 'blocked', freshness: 'stale' })
})

test('existing fixed evaluation receipts map to planned experiment and evaluation without claiming v2 execution', () => {
  const campaign = baseCampaign()
  campaign.artifactVersions.push(studyArtifact())
  const evaluation = task('existing-evaluation', 'evaluation', 'verified', 'supervised-phantom-v2')
  campaign.taskRevisions.push(evaluation)
  scientificEvidence(campaign, evaluation)
  const experimentNode = node(campaign, 'experiment')
  const evaluationNode = node(campaign, 'evaluation')
  expect(experimentNode).toMatchObject({
    state: 'satisfied',
    legacyEvidence: 'current_receipt_mapping',
  })
  expect(evaluationNode).toMatchObject({
    state: 'satisfied',
    legacyEvidence: 'current_receipt_mapping',
  })
  expect(experimentNode.explanation).toContain('映射既有固定合成评估回执')
})
