import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchAttempt, ResearchCampaign } from '@oph-autoresearch/core'
import { getWorkspace, type Store, withDerivedTaskStatuses } from '@oph-autoresearch/store'
import { formalWorkspaceBindingHash } from './formal-binding.ts'
import { formalExecutionPlanHash, isFormalOciJob } from './formal-job.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const HASH = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_RECEIPT_BYTES = 1_000_000
export interface FormalEvidenceMetrics {
  accuracy: number
  precision: number
  recall: number
  tp: number
  tn: number
  fp: number
  fn: number
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === keys.sort().join(',')
}

/** Read one bounded regular file, and reject directory replacement before publishing any bytes. */
async function receiptBytes(root: string, campaignId: string, attemptId: string, uri: string) {
  if (!ID.test(campaignId) || !ID.test(attemptId))
    throw new Error('Invalid formal receipt location')
  const lexicalRoot = resolve(root)
  const path = join(lexicalRoot, '.oph', 'research', campaignId, attemptId, 'formal-receipt.json')
  if (fileURLToPath(uri) !== path)
    throw new Error('Formal receipt is outside its fixed workspace location')
  // System aliases such as macOS /var are resolved once; project-relative symlinks are forbidden.
  const rootStat = await lstat(lexicalRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Formal workspace root must not be a symlink')
  const canonicalRoot = await realpath(lexicalRoot)
  const dirs = [canonicalRoot]
  for (const part of ['.oph', 'research', campaignId, attemptId])
    dirs.push(join(dirs.at(-1)!, part))
  const before = await Promise.all(dirs.map((dir) => lstat(dir)))
  if (before.some((stat) => !stat.isDirectory() || stat.isSymbolicLink()))
    throw new Error('Formal receipt directory is not a regular directory')
  const canonicalPath = join(dirs.at(-1)!, 'formal-receipt.json')
  const file = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RECEIPT_BYTES)
      throw new Error('Formal receipt is not a bounded regular file')
    const bytes = Buffer.alloc(stat.size)
    for (let offset = 0; offset < bytes.length; ) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('Formal receipt changed during reading')
      offset += bytesRead
    }
    const after = await file.stat()
    const entry = await lstat(canonicalPath)
    const dirsAfter = await Promise.all(dirs.map((dir) => lstat(dir)))
    if (
      (await realpath(lexicalRoot)) !== canonicalRoot ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1 ||
      entry.isSymbolicLink() ||
      entry.ino !== stat.ino ||
      entry.dev !== stat.dev ||
      dirsAfter.some(
        (value, i) =>
          !value.isDirectory() ||
          value.isSymbolicLink() ||
          value.ino !== before[i]!.ino ||
          value.dev !== before[i]!.dev,
      )
    )
      throw new Error('Formal receipt changed during reading')
    return bytes
  } finally {
    await file.close()
  }
}

/** Derive safe aggregate evidence from the exact persisted plan/job/producer chain, never from CLI prose. */
export async function readFormalEvidence(
  store: Store,
  workspaceRoot: string,
  campaign: ResearchCampaign,
  attempt: ResearchAttempt,
) {
  const workspace = getWorkspace(store, campaign.workspaceId as never)
  const spec = attempt.formalExecutionJobSpec
  const authority = attempt.formalExecutionAuthority
  const dispatch = campaign.formalExecutionDispatches?.find((item) => item.attemptId === attempt.id)
  const plan = campaign.formalExecutionPlans?.find((item) => item.planId === dispatch?.planId)
  const artifact = campaign.artifactVersions.find((item) => item.id === attempt.artifactVersionId)
  const candidate = campaign.artifactVersions.find((item) => item.id === plan?.candidateArtifactId)
  const labels = campaign.labelSets?.find((item) => item.contentHash === plan?.labelSetContentHash)
  const latestLabels = campaign.labelSets
    ?.filter((item) => item.id === labels?.id)
    .toSorted((a, b) => b.version - a.version)[0]
  const task = withDerivedTaskStatuses(campaign).taskRevisions.find(
    (item) => item.id === attempt.taskRevisionId,
  )
  if (
    !workspace ||
    resolve(workspace.rootPath) !== resolve(workspaceRoot) ||
    !workspace.serverBinding ||
    attempt.status !== 'completed' ||
    attempt.cancelRequestedAt != null ||
    attempt.resultDisposition === 'quarantined' ||
    !spec ||
    !isFormalOciJob(spec) ||
    !authority ||
    !dispatch ||
    !plan ||
    !artifact ||
    !candidate ||
    !labels ||
    latestLabels?.contentHash !== plan.labelSetContentHash ||
    candidate.kind !== 'cli_preparation_candidate' ||
    candidate.contentHash !== plan.candidateReceiptHash ||
    candidate.producerTaskRevisionId !== plan.taskRevisionId ||
    campaign.artifactVersions.some(
      (item) => item.artifactId === candidate.artifactId && item.version > candidate.version,
    ) ||
    task?.status !== 'verified' ||
    spec.campaignId !== campaign.id ||
    spec.taskRevisionId !== task.id ||
    spec.dispatchKey !== attempt.dispatchKey ||
    spec.dispatchKey !== attempt.id ||
    canonicalJson(spec.formalPlan) !== canonicalJson(plan) ||
    spec.formalPlanHash !== formalExecutionPlanHash(plan) ||
    sha256(canonicalJson(spec)) !== attempt.formalExecutionJobSpecHash ||
    authority.jobSpecHash !== attempt.formalExecutionJobSpecHash ||
    authority.epoch !== spec.execution.authorityEpoch ||
    !['acknowledged', 'observation_unknown'].includes(authority.dispatchState) ||
    authority.schema !== 'formal-execution-authority-binding-v1' ||
    dispatch.status !== 'completed' ||
    dispatch.planHash !== spec.formalPlanHash ||
    dispatch.receiptHash !== artifact.contentHash ||
    plan.workspaceBindingHash !==
      formalWorkspaceBindingHash(workspace.id, workspace.serverBinding) ||
    authority.workspaceBindingHash !== plan.workspaceBindingHash ||
    authority.profileId !== workspace.serverBinding.profileId ||
    authority.connectionHash !== workspace.serverBinding.connectionHash ||
    authority.remoteRoot !== workspace.serverBinding.remoteRoot ||
    (
      [
        'routeId',
        'profileId',
        'workspaceBindingHash',
        'connectionHash',
        'remoteRoot',
        'authorityId',
        'admissionEvidenceHash',
      ] as const
    ).some((key) => authority[key] !== dispatch[key]) ||
    artifact.kind !== 'formal_execution_receipt' ||
    artifact.schemaId !== 'research-formal-oci-receipt-v1' ||
    artifact.mediaType !== 'application/json' ||
    artifact.dataClass !== 'restricted-reference' ||
    artifact.artifactId !== plan.planId ||
    artifact.producerAttemptId !== attempt.id ||
    artifact.producerTaskRevisionId !== task.id ||
    campaign.artifactVersions.some(
      (item) => item.artifactId === artifact.artifactId && item.version > artifact.version,
    )
  )
    throw new Error('Formal evidence is not bound to a current completed execution')
  const bytes = await receiptBytes(workspaceRoot, campaign.id, attempt.id, artifact.uri)
  if (sha256(bytes) !== artifact.contentHash) throw new Error('Formal receipt hash mismatch')
  const receipt: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    !object(receipt) ||
    !exactKeys(receipt, [
      'schema',
      'planHash',
      'codeHash',
      'imageDigest',
      'dataManifestHash',
      'labelSetContentHash',
      'evaluatorHash',
      'predictionHash',
      'metrics',
    ]) ||
    receipt.schema !== 'research-formal-oci-receipt-v1' ||
    receipt.planHash !== spec.formalPlanHash ||
    receipt.codeHash !== plan.codeHash ||
    receipt.imageDigest !== plan.ociImageDigest ||
    receipt.dataManifestHash !== plan.dataManifestHash ||
    receipt.labelSetContentHash !== plan.labelSetContentHash ||
    receipt.evaluatorHash !== plan.trustedEvaluatorHash ||
    typeof receipt.predictionHash !== 'string' ||
    !HASH.test(receipt.predictionHash) ||
    !object(receipt.metrics) ||
    !exactKeys(receipt.metrics, ['accuracy', 'precision', 'recall', 'tp', 'tn', 'fp', 'fn'])
  )
    throw new Error('Formal receipt does not match the frozen plan')
  const metrics = receipt.metrics
  if (
    !['tp', 'tn', 'fp', 'fn'].every(
      (key) => Number.isSafeInteger(metrics[key]) && (metrics[key] as number) >= 0,
    )
  )
    throw new Error('Invalid formal confusion counts')
  const { tp, tn, fp, fn } = metrics as unknown as FormalEvidenceMetrics
  const total = tp + tn + fp + fn
  if (!Number.isSafeInteger(total) || total === 0) throw new Error('Invalid formal sample count')
  const verified: FormalEvidenceMetrics = {
    tp,
    tn,
    fp,
    fn,
    accuracy: (tp + tn) / total,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
  }
  if (
    !(['accuracy', 'precision', 'recall'] as const).every(
      (key) =>
        typeof metrics[key] === 'number' &&
        Number.isFinite(metrics[key]) &&
        Math.abs(metrics[key] - verified[key]) <= 1e-12,
    )
  )
    throw new Error('Formal metrics disagree with independent confusion-count computation')
  return {
    artifactVersionId: artifact.id,
    inputHash: spec.formalPlanHash,
    contentHash: artifact.contentHash,
    byteLength: bytes.length,
    metrics: verified,
  }
}
