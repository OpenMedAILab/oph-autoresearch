import type { SyntheticCompletionValidation } from '@oph-autoresearch/core'
import { canonicalJson, sha256 } from './skill-lock.ts'
import {
  createRunnerDvcCollector,
  createRunnerMlflowCollector,
  type MlflowAggregate,
  type RunnerDvcSource,
  type RunnerMlflowSource,
} from './tracking-adapters.ts'

type DvcAggregate = Awaited<ReturnType<ReturnType<typeof createRunnerDvcCollector>>>
export interface RunnerTrackingConfig {
  schema: 'runner-tracking-config-v1'
  dataClass: 'synthetic'
  mlflow: RunnerMlflowSource[]
  dvc: RunnerDvcSource[]
}
export interface RunnerTrackingReceipt {
  schema: 'runner-tracking-receipt-v1'
  policyHash: string
  dispatchKey: string
  templateOutputHash: string
  observedAt: number
  workerPid: number
  sources: Array<MlflowAggregate | DvcAggregate>
}
const HASH = /^sha256:[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid tracking contract')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('Unexpected tracking fields')
}
function fields(value: unknown) {
  const values = object(value)
  if (Object.keys(values).length > 64) throw new Error('Too many tracking values')
  for (const [key, number] of Object.entries(values))
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
      (number !== null && (typeof number !== 'number' || !Number.isFinite(number)))
    )
      throw new Error('Tracking output must contain bounded numeric fields')
}

/** Captures startup configuration; this function does not contact providers or read a repository.
 * The supported application deployment is synthetic only. Clinical service configuration
 * requires a separately admitted remote deployment; this switch does not anonymize data.
 */
export function captureRunnerTracking(input: unknown) {
  const config = object(input)
  exact(config, ['schema', 'dataClass', 'mlflow', 'dvc'])
  if (
    config.schema !== 'runner-tracking-config-v1' ||
    config.dataClass !== 'synthetic' ||
    !Array.isArray(config.mlflow) ||
    !Array.isArray(config.dvc) ||
    config.mlflow.length + config.dvc.length < 1 ||
    config.mlflow.length + config.dvc.length > 4
  )
    throw new Error('Only bounded synthetic tracking sources are supported')
  if (JSON.stringify(config).length > 64_000) throw new Error('Tracking configuration is too large')
  const captured = structuredClone(config) as unknown as RunnerTrackingConfig
  const ids = new Set<string>()
  for (const source of captured.mlflow) {
    exact(object(source), [
      'referenceId',
      'baseUrl',
      'runId',
      'metrics',
      'numericParams',
      ...(source.authorization === undefined ? [] : ['authorization']),
    ])
    createRunnerMlflowCollector(source)
    if (ids.has(source.referenceId)) throw new Error('Tracking references must be unique')
    ids.add(source.referenceId)
  }
  for (const source of captured.dvc) {
    exact(object(source), ['referenceId', 'repositoryRoot', 'revision'])
    if (
      typeof source.repositoryRoot !== 'string' ||
      source.repositoryRoot.length > 4096 ||
      source.repositoryRoot.length === 0
    )
      throw new Error('Invalid DVC repository configuration')
    createRunnerDvcCollector(source)
    if (ids.has(source.referenceId)) throw new Error('Tracking references must be unique')
    ids.add(source.referenceId)
  }
  const policyHash = sha256(
    canonicalJson({
      ...captured,
      mlflow: captured.mlflow.map(({ authorization: _authorization, ...source }) => source),
    }),
  )
  return { config: captured, policyHash }
}

/** Must execute in the trusted worker, before any output crosses the daemon boundary. */
export async function collectRunnerTracking(
  config: RunnerTrackingConfig,
  binding: { dispatchKey: string; policyHash: string; payload: unknown },
): Promise<RunnerTrackingReceipt> {
  const captured = captureRunnerTracking(config)
  if (captured.policyHash !== binding.policyHash) throw new Error('Tracking startup policy drift')
  const sources = await Promise.all([
    ...captured.config.mlflow.map((source) => createRunnerMlflowCollector(source)()),
    ...captured.config.dvc.map((source) => createRunnerDvcCollector(source)()),
  ])
  return validateRunnerTrackingReceipt({
    schema: 'runner-tracking-receipt-v1',
    policyHash: captured.policyHash,
    dispatchKey: binding.dispatchKey,
    templateOutputHash: sha256(canonicalJson(binding.payload)),
    observedAt: Date.now(),
    workerPid: process.pid,
    sources,
  })
}

export function validateRunnerTrackingReceipt(value: unknown): RunnerTrackingReceipt {
  const receipt = object(value)
  exact(receipt, [
    'schema',
    'policyHash',
    'dispatchKey',
    'templateOutputHash',
    'observedAt',
    'workerPid',
    'sources',
  ])
  if (
    receipt.schema !== 'runner-tracking-receipt-v1' ||
    !HASH.test(String(receipt.policyHash)) ||
    !HASH.test(String(receipt.templateOutputHash)) ||
    typeof receipt.dispatchKey !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.dispatchKey) ||
    !Number.isSafeInteger(receipt.observedAt) ||
    (receipt.observedAt as number) < 1 ||
    !Number.isSafeInteger(receipt.workerPid) ||
    (receipt.workerPid as number) < 1 ||
    !Array.isArray(receipt.sources) ||
    receipt.sources.length < 1 ||
    receipt.sources.length > 4
  )
    throw new Error('Invalid tracking receipt')
  const ids = new Set<string>()
  for (const raw of receipt.sources) {
    const source = object(raw)
    if (
      typeof source.referenceId !== 'string' ||
      !UUID.test(source.referenceId) ||
      ids.has(source.referenceId)
    )
      throw new Error('Invalid tracking source reference')
    ids.add(source.referenceId)
    if (source.source === 'mlflow') {
      exact(source, [
        'source',
        'referenceId',
        'status',
        'metrics',
        'numericParams',
        'verification',
        'artifactAccess',
      ])
      if (
        !['RUNNING', 'SCHEDULED', 'FINISHED', 'FAILED', 'KILLED'].includes(String(source.status)) ||
        source.verification !== 'provider-reported' ||
        source.artifactAccess !== 'not-collected'
      )
        throw new Error('Invalid MLflow receipt')
      fields(source.metrics)
      fields(source.numericParams)
    } else if (source.source === 'dvc') {
      exact(source, [
        'source',
        'referenceId',
        'revision',
        'lockSha256',
        'lockByteLength',
        'verification',
        'dataAccess',
      ])
      if (
        !/^[a-f0-9]{40}$/.test(String(source.revision)) ||
        !HASH.test(String(source.lockSha256)) ||
        !Number.isSafeInteger(source.lockByteLength) ||
        (source.lockByteLength as number) < 1 ||
        (source.lockByteLength as number) > 1024 * 1024 ||
        source.verification !== 'git-lock-bytes' ||
        source.dataAccess !== 'not-collected'
      )
        throw new Error('Invalid DVC receipt')
    } else throw new Error('Unknown tracking provider')
  }
  return structuredClone(receipt) as unknown as RunnerTrackingReceipt
}

export function trackingFromOutput(bytes: Uint8Array): RunnerTrackingReceipt | undefined {
  if (bytes.byteLength > 128_000) throw new Error('Tracked output exceeds size limit')
  const output = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (!Object.hasOwn(output, 'tracking')) return undefined
  const { tracking, ...payload } = output
  const receipt = validateRunnerTrackingReceipt(tracking)
  if (receipt.templateOutputHash !== sha256(canonicalJson(payload)))
    throw new Error('Tracking does not bind the template output')
  return receipt
}
export function verifyTrackingBinding(
  bytes: Uint8Array,
  binding: { dispatchKey: string; trackingPolicyHash?: string },
) {
  const receipt = trackingFromOutput(bytes)
  if (
    receipt
      ? receipt.dispatchKey !== binding.dispatchKey ||
        receipt.policyHash !== binding.trackingPolicyHash
      : binding.trackingPolicyHash !== undefined
  )
    throw new Error('Tracking output does not bind its approved job')
  return receipt
}
export function verifyTrackedTemplate(
  base: (bytes: Uint8Array) => SyntheticCompletionValidation,
  bytes: Uint8Array,
): SyntheticCompletionValidation {
  const tracking = trackingFromOutput(bytes)
  if (!tracking) return base(bytes)
  const { tracking: _tracking, ...payload } = JSON.parse(new TextDecoder().decode(bytes))
  const result = base(new TextEncoder().encode(`${JSON.stringify(payload)}\n`))
  return { ...result, contentHash: sha256(bytes), byteLength: bytes.byteLength }
}
