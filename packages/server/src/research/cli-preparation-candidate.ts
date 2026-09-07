import { createHash } from 'node:crypto'
import type { CliPreparationDraft } from './cli-preparation.ts'
import type { CliPreparationJobSpec } from './cli-preparation-job.ts'

export interface CliPreparationCandidateReceipt {
  schema: 'research-cli-preparation-candidate-v1'
  jobSpecHash: string
  dispatchKey: string
  clientDispatchKey: string
  preparationId: string
  candidateId: string
  taskRevisionId: string
  inputHash: string
  configHash: string
  draft: CliPreparationDraft
}

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

const DRAFT_KEYS = [
  'adapter',
  'code',
  'configHash',
  'contentHash',
  'humanApprovalRequired',
  'inputHash',
  'patch',
  'schema',
  'specHash',
  'taskRevisionId',
  'usage',
]
const RECEIPT_KEYS = [
  'candidateId',
  'clientDispatchKey',
  'configHash',
  'dispatchKey',
  'draft',
  'inputHash',
  'jobSpecHash',
  'preparationId',
  'schema',
  'taskRevisionId',
]
const SHA256 = /^sha256:[a-f0-9]{64}$/
const MAX_DRAFT_BYTES = 256_000

export function cliPreparationJobSpecHash(spec: CliPreparationJobSpec): string {
  return `sha256:${createHash('sha256').update(canonical(spec)).digest('hex')}`
}

export function candidateReceipt(
  spec: CliPreparationJobSpec,
  draft: CliPreparationDraft,
): CliPreparationCandidateReceipt {
  return {
    schema: 'research-cli-preparation-candidate-v1',
    jobSpecHash: cliPreparationJobSpecHash(spec),
    dispatchKey: spec.dispatchKey,
    clientDispatchKey: spec.execution.clientDispatchKey,
    preparationId: spec.execution.preparationId,
    candidateId: spec.execution.candidateId,
    taskRevisionId: spec.taskRevisionId,
    inputHash: spec.inputHash,
    configHash: spec.execution.configHash,
    draft,
  }
}

export function verifyCandidateReceipt(
  value: unknown,
  spec: CliPreparationJobSpec,
): value is CliPreparationCandidateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  if (
    Object.keys(receipt).sort().join(',') !== RECEIPT_KEYS.join(',') ||
    receipt.schema !== 'research-cli-preparation-candidate-v1' ||
    receipt.jobSpecHash !== cliPreparationJobSpecHash(spec) ||
    receipt.dispatchKey !== spec.dispatchKey ||
    receipt.clientDispatchKey !== spec.execution.clientDispatchKey ||
    receipt.preparationId !== spec.execution.preparationId ||
    receipt.candidateId !== spec.execution.candidateId ||
    receipt.taskRevisionId !== spec.taskRevisionId ||
    receipt.inputHash !== spec.inputHash ||
    receipt.configHash !== spec.execution.configHash ||
    !receipt.draft ||
    typeof receipt.draft !== 'object' ||
    Array.isArray(receipt.draft)
  )
    return false
  const draft = receipt.draft as Record<string, unknown>
  if (
    Object.keys(draft).sort().join(',') !== DRAFT_KEYS.join(',') ||
    draft.schema !== 'research-cli-preparation-draft-v1' ||
    draft.taskRevisionId !== spec.taskRevisionId ||
    !SHA256.test(String(draft.specHash)) ||
    !SHA256.test(String(draft.inputHash)) ||
    !SHA256.test(String(draft.configHash)) ||
    draft.inputHash !== draft.specHash ||
    draft.configHash !== spec.execution.adapterConfigHash ||
    !SHA256.test(String(draft.contentHash)) ||
    typeof draft.code !== 'string' ||
    !draft.code ||
    Buffer.byteLength(draft.code, 'utf8') > MAX_DRAFT_BYTES ||
    (draft.patch !== null && typeof draft.patch !== 'string') ||
    (typeof draft.patch === 'string' && Buffer.byteLength(draft.patch, 'utf8') > MAX_DRAFT_BYTES) ||
    draft.usage !== null ||
    draft.humanApprovalRequired !== true ||
    !draft.adapter ||
    typeof draft.adapter !== 'object' ||
    Array.isArray(draft.adapter)
  )
    return false
  const adapter = draft.adapter as Record<string, unknown>
  if (
    Object.keys(adapter).sort().join(',') !== 'id,identity,model' ||
    typeof adapter.id !== 'string' ||
    adapter.id !== spec.execution.adapterId ||
    adapter.id.length > 128 ||
    adapter.model !== spec.execution.model ||
    adapter.model.length > 256 ||
    typeof adapter.identity !== 'string' ||
    !adapter.identity ||
    adapter.identity.length > 2048
  )
    return false
  const expected = `sha256:${createHash('sha256')
    .update(canonical({ code: draft.code, patch: draft.patch }))
    .digest('hex')}`
  return draft.contentHash === expected
}
