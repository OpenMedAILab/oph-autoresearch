import type {
  ArtifactVersion,
  ConversationId,
  ResearchCampaign,
  WorkflowCallRecord,
} from '@oph-autoresearch/core'
import {
  foldWorkflow,
  parseModelReview,
  parseTerminalJson,
  workflowAncestors,
} from '@oph-autoresearch/core'
import { getConversation, getWorkspace, type Store } from '@oph-autoresearch/store'
import { campaignSteps, experimentSources } from './experiment-sources.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

type Document = Record<string, unknown>
export type WorkflowReviewEvidence = {
  review: { id: string; artifactVersionIds: string[] }
  map: ReturnType<typeof parseModelReview>
  workflow: true
}

/** Workflow prose may precede one terminal JSON result; the result itself is never rewritten. */
export function parseWorkflowReview(output: string, artifactIds: string[]) {
  if (output.length > 16_000) throw new Error('Review output exceeds limit')
  const document = parseTerminalJson(output)
  return parseModelReview(JSON.stringify(document.review ?? document), artifactIds)
}

/** SSH and workflow records establish provenance, never formal execution or human approval. */
export function workflowDocumentEvidence(
  store: Store,
  campaign: ResearchCampaign,
  artifacts: ArtifactVersion[],
  contents: (Document | null)[],
) {
  const parent = campaign.parentConversationId as ConversationId
  const steps = campaignSteps(store, parent)
  const sources = experimentSources(steps)
  const records: WorkflowCallRecord[] = steps.flatMap((step) => {
    if (
      step.toolName !== 'workflow' ||
      step.payload?.kind !== 'tool_result' ||
      step.payload.outcome.executed !== true
    )
      return []
    return [
      {
        stepId: step.id,
        ...(step.payload.args ? { args: step.payload.args } : {}),
        outcome: step.payload.outcome,
        status: step.status === 'success' ? 'success' : 'failure',
      },
    ]
  })
  const latest = (artifact: ArtifactVersion) =>
    !artifacts.some(
      (other) => other.artifactId === artifact.artifactId && other.version > artifact.version,
    )
  const workspace = getWorkspace(store, campaign.workspaceId as never)
  const studyCurrent = (doc: Document) =>
    !!campaign.studySelection &&
    doc.studyHash === campaign.studySelection.contentHash &&
    campaign.studySelection.localRoot === workspace?.rootPath &&
    campaign.studySelection.serverBindingHash ===
      (workspace?.serverBinding ? sha256(canonicalJson(workspace.serverBinding)) : null) &&
    artifacts.some(
      (a, i) =>
        a.kind === 'research-document-study' &&
        latest(a) &&
        a.contentHash === doc.studyHash &&
        !!contents[i],
    )
  const validExperiments = new Set<string>()
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i]!,
      doc = contents[i]
    if (
      artifact.kind !== 'research-document-experiment' ||
      !doc ||
      !latest(artifact) ||
      !studyCurrent(doc)
    )
      continue
    if (
      sources.some(
        (source) =>
          source.sourceStepId === doc.sourceStepId &&
          source.statusStepId === doc.statusStepId &&
          canonicalJson(source.summary) === canonicalJson(doc.summary),
      )
    )
      validExperiments.add(artifact.id)
  }
  const reviews: WorkflowReviewEvidence[] = []
  const validReviews = new Set<string>()
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i]!,
      doc = contents[i]
    if (
      artifact.kind !== 'research-document-resultsreview' ||
      !doc ||
      !latest(artifact) ||
      !studyCurrent(doc) ||
      !Array.isArray(doc.experimentIds) ||
      !doc.experimentIds.length ||
      !doc.experimentIds.every(
        (id): id is string => typeof id === 'string' && validExperiments.has(id),
      ) ||
      typeof doc.workflowId !== 'string' ||
      typeof doc.nodeId !== 'string'
    )
      continue
    const folded = foldWorkflow(records, doc.workflowId)
    if (!folded.ok || folded.projection.phase !== 'completed') continue
    if (
      !folded.projection.nodes.some(
        (node) =>
          node.kind === 'checkpoint' &&
          workflowAncestors(folded.projection.nodes, node.id).has(doc.nodeId as string) &&
          folded.projection.approvals[node.id],
      )
    )
      continue
    const result = folded.projection.results[doc.nodeId]
    if (
      !result ||
      result.status !== 'done' ||
      !result.conversationId ||
      !['independent-reviewer', 'reproducibility-auditor'].includes(result.agent)
    )
      continue
    const child = getConversation(store, result.conversationId as ConversationId)
    if (
      !child ||
      child.parentConversationId !== parent ||
      child.workspaceId !== campaign.workspaceId
    )
      continue
    try {
      const map = parseWorkflowReview(result.output, doc.experimentIds)
      if (canonicalJson(map) !== canonicalJson(doc.review)) continue
      validReviews.add(artifact.id)
      if (map.decision === 'supported')
        reviews.push({
          review: { id: artifact.id, artifactVersionIds: doc.experimentIds },
          map,
          workflow: true,
        })
    } catch {
      /* The independent node must return the exact structured claim map. */
    }
  }
  return { validExperiments, validReviews, reviews }
}
