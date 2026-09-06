/**
 * Frozen, admission-ready execution plans.  This is deliberately a small
 * allow-listed contract: it carries digests and fixed container paths, never a
 * host command, host path, credential, or shell fragment.
 */
export const FORMAL_EXECUTION_SCHEMA = 'research-formal-plan-v1' as const
export const FORMAL_ENTRY_ARGV = ['python3', 'main.py'] as const
export const FORMAL_DATASET_TARGET = '/dataset' as const
export const FORMAL_OUTPUT_TARGET = '/out' as const

export interface FormalExecutionResources {
  maxRuntimeMs: number
  cpu: number
  memoryMb: number
  pidsLimit: number
  network: 'disabled'
}

export interface FormalExecutionPlan {
  schema: typeof FORMAL_EXECUTION_SCHEMA
  planId: string
  taskRevisionId: string
  candidateArtifactId: string
  codeHash: string
  candidateReceiptHash: string
  /** Digest of local workspace id + pinned SSH connection hash + remote root. */
  workspaceBindingHash: string
  ociImageDigest: string
  entryArgv: typeof FORMAL_ENTRY_ARGV
  dataManifestHash: string
  /** Immutable admitted labels; worker output cannot supply or replace truth. */
  labelSetContentHash: string
  trustedEvaluatorId: string
  /** Administrator-pinned evaluator implementation, e.g. binary-classification-v1. */
  trustedEvaluatorHash: string
  resources: FormalExecutionResources
  datasetMount: { target: typeof FORMAL_DATASET_TARGET; readOnly: true }
  outputMount: { target: typeof FORMAL_OUTPUT_TARGET }
}

export type FormalReviewDecision = 'accepted' | 'rejected' | 'needs_changes'

export interface FormalCodeReviewResult {
  schema: 'research-formal-code-review-v1'
  reviewId: string
  reviewKind: 'isolated-api' | 'human-signed'
  candidateArtifactId: string
  taskRevisionId: string
  codeHash: string
  candidateReceiptHash: string
  workspaceBindingHash: string
  ociImageDigest: string
  dataManifestHash: string
  trustedEvaluatorId: string
  decision: FormalReviewDecision
  findings: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>
  reviewedAt: number
  reviewerId: string
  /** Present only for an isolated API review that actually ran. */
  runnerReceiptHash?: string
}

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

/** Stable bytes bound by the formal-execution human approval. */
export function canonicalFormalExecutionPlan(plan: FormalExecutionPlan): string {
  return canonical(plan)
}

/** Runtime-neutral digest helper; server/store may use their platform crypto for persistence. */
export function validFormalExecutionPlan(plan: unknown): plan is FormalExecutionPlan {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false
  const value = plan as Record<string, unknown>
  const keys = Object.keys(value).sort()
  const expected = [
    'candidateArtifactId',
    'candidateReceiptHash',
    'codeHash',
    'dataManifestHash',
    'datasetMount',
    'entryArgv',
    'labelSetContentHash',
    'ociImageDigest',
    'outputMount',
    'planId',
    'resources',
    'schema',
    'taskRevisionId',
    'trustedEvaluatorId',
    'trustedEvaluatorHash',
    'workspaceBindingHash',
  ]
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false
  const resources = value.resources as Record<string, unknown> | null
  const datasetMount = value.datasetMount as Record<string, unknown> | null
  const outputMount = value.outputMount as Record<string, unknown> | null
  return Boolean(
    value.schema === FORMAL_EXECUTION_SCHEMA &&
      [
        value.planId,
        value.taskRevisionId,
        value.candidateArtifactId,
        value.trustedEvaluatorId,
      ].every((item) => typeof item === 'string' && ID.test(item)) &&
      [
        value.codeHash,
        value.candidateReceiptHash,
        value.workspaceBindingHash,
        value.ociImageDigest,
        value.dataManifestHash,
        value.labelSetContentHash,
        value.trustedEvaluatorHash,
      ].every((item) => typeof item === 'string' && SHA256.test(item)) &&
      Array.isArray(value.entryArgv) &&
      value.entryArgv.length === FORMAL_ENTRY_ARGV.length &&
      value.entryArgv.every((item, index) => item === FORMAL_ENTRY_ARGV[index]) &&
      resources &&
      Object.keys(resources).sort().join(',') === 'cpu,maxRuntimeMs,memoryMb,network,pidsLimit' &&
      Number.isSafeInteger(resources.maxRuntimeMs) && resources.maxRuntimeMs > 0 && resources.maxRuntimeMs <= 24 * 60 * 60 * 1000 &&
      Number.isSafeInteger(resources.cpu) && resources.cpu > 0 && resources.cpu <= 256 &&
      Number.isSafeInteger(resources.memoryMb) && resources.memoryMb >= 128 && resources.memoryMb <= 1_048_576 &&
      Number.isSafeInteger(resources.pidsLimit) && resources.pidsLimit >= 1 && resources.pidsLimit <= 65_536 &&
      resources.network === 'disabled' &&
      datasetMount && datasetMount.target === FORMAL_DATASET_TARGET && datasetMount.readOnly === true &&
      Object.keys(datasetMount).length === 2 &&
      outputMount && outputMount.target === FORMAL_OUTPUT_TARGET && Object.keys(outputMount).length === 1,
  )
}

export function validFormalCodeReviewResult(value: unknown): value is FormalCodeReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const review = value as Record<string, unknown>
  const hasRunnerReceipt = Object.hasOwn(review, 'runnerReceiptHash')
  const expected = hasRunnerReceipt
    ? ['candidateArtifactId', 'candidateReceiptHash', 'codeHash', 'dataManifestHash', 'decision', 'findings', 'ociImageDigest', 'reviewId', 'reviewKind', 'reviewedAt', 'reviewerId', 'runnerReceiptHash', 'schema', 'taskRevisionId', 'trustedEvaluatorId', 'workspaceBindingHash']
    : ['candidateArtifactId', 'candidateReceiptHash', 'codeHash', 'dataManifestHash', 'decision', 'findings', 'ociImageDigest', 'reviewId', 'reviewKind', 'reviewedAt', 'reviewerId', 'schema', 'taskRevisionId', 'trustedEvaluatorId', 'workspaceBindingHash']
  if (
    Object.keys(review).sort().join(',') !== expected.join(',') ||
    review.schema !== 'research-formal-code-review-v1' ||
    !['isolated-api', 'human-signed'].includes(String(review.reviewKind)) ||
    !['accepted', 'rejected', 'needs_changes'].includes(String(review.decision)) ||
    !Number.isSafeInteger(review.reviewedAt) ||
    !Array.isArray(review.findings) || review.findings.length > 100 ||
    (hasRunnerReceipt && (typeof review.runnerReceiptHash !== 'string' || !SHA256.test(review.runnerReceiptHash))) ||
    (review.reviewKind === 'human-signed' && hasRunnerReceipt)
  ) return false
  const ids = [
    review.reviewId, review.candidateArtifactId, review.taskRevisionId, review.trustedEvaluatorId, review.reviewerId,
  ]
  const hashes = [
    review.codeHash, review.candidateReceiptHash, review.workspaceBindingHash, review.ociImageDigest, review.dataManifestHash,
  ]
  return ids.every((item) => typeof item === 'string' && ID.test(item)) &&
    hashes.every((item) => typeof item === 'string' && SHA256.test(item)) &&
    review.findings.every((finding) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false
      const row = finding as Record<string, unknown>
      return Object.keys(row).sort().join(',') === 'code,message,severity' &&
        ['info', 'warning', 'error'].includes(String(row.severity)) &&
        typeof row.code === 'string' && ID.test(row.code) &&
        typeof row.message === 'string' && row.message.length <= 4000
    }) && !(review.decision === 'accepted' && review.findings.some((finding) => finding.severity === 'error'))
}
    'labelSetContentHash',
