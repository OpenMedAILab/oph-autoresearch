import { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  ResearchAuthorityClosureProof,
  ResearchAuthorityClosureRequest,
  ResearchAuthorityIdentity,
  ResearchJobSpec,
  ResearchTemplateId,
} from '@oph-autoresearch/core'
import { verifyCandidateReceipt } from './cli-preparation-candidate.ts'
import {
  type CliPreparationAdministratorConfig,
  type CliPreparationJobSpec,
  cliPreparationAdapterConfigHash,
  cliPreparationExecutableHash,
  type DaemonJobSpec,
  isCliPreparationJob,
} from './cli-preparation-job.ts'
import { type FormalOciJobSpec, isFormalOciJob } from './formal-job.ts'
import { FormalOciAdapter, type FormalOciAdministratorConfig } from './formal-oci.ts'
import { verifyFormalReceiptInThread } from './formal-oci-thread.ts'
import {
  captureRunnerTracking,
  type RunnerTrackingConfig,
  verifyTrackingBinding,
} from './runner-tracking.ts'
import { fixedResearchTemplate } from './template-registry.ts'

const MAX_CLI_PREPARATION_RECEIPT_BYTES = 600_000

export type JobTemplate = ResearchTemplateId
export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'completion_requested'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
export type JobSpec = DaemonJobSpec | FormalOciJobSpec
export type {
  CliPreparationAdministratorConfig,
  CliPreparationJobSpec,
} from './cli-preparation-job.ts'
export interface DurableJob {
  spec: JobSpec
  specHash: string
  /** Mutable authority state. It is deliberately outside the signed JobSpec. */
  runtimeLease?: JobSpec['lease']
  executionDeadlineAt?: number
  workerHeartbeatAt?: number
  /** First durable request to reap this job's confirmed process group. */
  cleanupStartedAt?: number
  status: JobStatus
  outputPath: string | null
  contentHash: string | null
  error: string | null
}
export interface JobDaemonPort {
  submit(spec: unknown, expectedEpoch?: string): DurableJob
  query(dispatchKey: string): DurableJob | null
  cancel(dispatchKey: string, expectedEpoch?: string): DurableJob | null
}
export interface JobDaemonEndpoint {
  endpoint: string
  token: string
}

/**
 * A PID is not a durable process identity: operating systems may reuse it after an
 * authority restart.  The start marker is deliberately platform-specific and is
 * only used as an equality token; when it cannot be obtained, the daemon keeps a
 * job non-terminal rather than guessing.
 */
export interface ProcessProbe {
  startIdentity(pid: number): string | null
}

function platformProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat field 22 is the process start time.  comm may contain
      // spaces and ')' characters, so split only after its final delimiter.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const tail = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)
      const startTime = tail[19]
      return startTime ? `linux:${startTime}` : null
    }
    if (process.platform === 'darwin') {
      const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const started = new TextDecoder().decode(result.stdout).trim()
      return started ? `darwin:${started}` : null
    }
  } catch {
    // Permission and process-exit races are both unknown, never proof of exit.
  }
  return null
}

type ProcessIdentityState = 'match' | 'missing' | 'mismatch' | 'unknown'

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
function hash(value: unknown) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}
function hashBytes(value: Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
function validText(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
function closureRequest(value: unknown): ResearchAuthorityClosureRequest {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['dispatchKey', 'expectedEpoch', 'specHash']) ||
    !validText(value.dispatchKey) ||
    typeof value.expectedEpoch !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.expectedEpoch) ||
    typeof value.specHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.specHash)
  )
    throw new Error('invalid authority closure request')
  return value as unknown as ResearchAuthorityClosureRequest
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function parseCliPreparation(value: Record<string, unknown>): CliPreparationJobSpec {
  if (
    !hasKeys(value, [
      'campaignId',
      'backendPolicyHash',
      'dispatchKey',
      'execution',
      'inputHash',
      'lease',
      'resource',
      'taskRevisionId',
      'templateId',
      'version',
    ]) ||
    !isRecord(value.resource) ||
    !hasKeys(value.resource, ['cpu', 'memoryMb']) ||
    !isRecord(value.lease) ||
    !hasKeys(value.lease, ['expiresAt', 'fence', 'ownerId', 'token']) ||
    !isRecord(value.execution) ||
    !hasKeys(value.execution, [
      'adapter',
      'adapterId',
      'adapterConfigHash',
      'candidateId',
      'clientDispatchKey',
      'configHash',
      'deviceId',
      'instructions',
      'maxCost',
      'maxRuntimeMs',
      'model',
      'preparationId',
    ])
  )
    throw new Error('invalid CLI preparation JobSpec schema')
  const resource = value.resource
  const lease = value.lease
  const execution = value.execution
  if (
    value.version !== 3 ||
    execution.adapter !== 'cli-preparation-v1' ||
    !['preparationId', 'candidateId', 'clientDispatchKey', 'adapterId', 'deviceId'].every((key) =>
      validText(execution[key]),
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(execution.adapterConfigHash)) ||
    typeof execution.model !== 'string' ||
    execution.model.length < 1 ||
    execution.model.length > 256 ||
    typeof execution.instructions !== 'string' ||
    execution.instructions.length < 1 ||
    execution.instructions.length > 32_000 ||
    !/^sha256:[a-f0-9]{64}$/.test(String(execution.configHash)) ||
    typeof execution.maxRuntimeMs !== 'number' ||
    !Number.isSafeInteger(execution.maxRuntimeMs) ||
    execution.maxRuntimeMs < 1 ||
    execution.maxRuntimeMs > 600_000 ||
    typeof execution.maxCost !== 'number' ||
    !Number.isFinite(execution.maxCost) ||
    execution.maxCost <= 0 ||
    !validText(value.dispatchKey) ||
    !validText(value.campaignId) ||
    !validText(value.taskRevisionId) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.backendPolicyHash)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.inputHash)) ||
    resource.cpu !== 1 ||
    typeof resource.memoryMb !== 'number' ||
    !Number.isSafeInteger(resource.memoryMb) ||
    resource.memoryMb !== 256 ||
    !validText(lease.ownerId) ||
    !validText(lease.token) ||
    typeof lease.fence !== 'number' ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 1 ||
    !Number.isSafeInteger(lease.expiresAt)
  )
    throw new Error('invalid CLI preparation JobSpec values')
  try {
    fixedResearchTemplate(value.templateId)
  } catch {
    throw new Error('invalid CLI preparation JobSpec template')
  }
  return value as unknown as CliPreparationJobSpec
}
function parse(value: unknown): JobSpec {
  if (!isRecord(value)) throw new Error('invalid JobSpec')
  if (value.version === 4) {
    if (!isFormalOciJob(value)) throw new Error('invalid formal OCI JobSpec')
    return value
  }
  if (value.version === 3) return parseCliPreparation(value)
  if (
    !hasKeys(value, [
      ...(value.trackingPolicyHash === undefined ? [] : ['trackingPolicyHash']),
      ...(value.backendPolicyHash === undefined ? [] : ['backendPolicyHash']),
      ...(value.execution === undefined ? [] : ['execution']),
      'campaignId',
      'dispatchKey',
      'inputHash',
      'lease',
      'resource',
      'taskRevisionId',
      'templateId',
      'version',
    ])
  )
    throw new Error('invalid JobSpec schema')
  if (!isRecord(value.resource) || !hasKeys(value.resource, ['cpu', 'memoryMb']))
    throw new Error('invalid JobSpec resource')
  if (!isRecord(value.lease) || !hasKeys(value.lease, ['expiresAt', 'fence', 'ownerId', 'token']))
    throw new Error('invalid JobSpec lease')
  const resource = value.resource
  const lease = value.lease
  if (
    (value.version !== 1 && value.version !== 2) ||
    (value.version === 1 && value.execution !== undefined) ||
    (value.version === 2 &&
      (!isRecord(value.execution) ||
        !hasKeys(value.execution, ['adapter', 'codeHash', 'maxRuntimeMs']) ||
        value.templateId !== 'supervised-phantom-v2' ||
        value.execution.adapter !== 'supervised-phantom-v2' ||
        value.execution.codeHash !==
          fixedResearchTemplate('supervised-phantom-v2').binding.sourceHash ||
        value.execution.maxRuntimeMs !== 600_000)) ||
    (value.backendPolicyHash !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(String(value.backendPolicyHash))) ||
    !validText(value.dispatchKey) ||
    !validText(value.campaignId) ||
    !validText(value.taskRevisionId) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.inputHash)) ||
    resource.cpu !== 1 ||
    typeof resource.memoryMb !== 'number' ||
    !Number.isSafeInteger(resource.memoryMb) ||
    resource.memoryMb < 128 ||
    resource.memoryMb > 4096 ||
    !validText(lease.ownerId) ||
    !validText(lease.token) ||
    typeof lease.fence !== 'number' ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 1 ||
    !Number.isSafeInteger(lease.expiresAt)
  )
    throw new Error('invalid JobSpec values')
  try {
    fixedResearchTemplate(value.templateId)
  } catch {
    throw new Error('invalid JobSpec template')
  }
  return value as unknown as ResearchJobSpec
}
function row(value: Record<string, unknown> | null): DurableJob | null {
  return value
    ? {
        spec: JSON.parse(String(value.spec)) as JobSpec,
        specHash: String(value.spec_hash),
        ...(value.runtime_lease
          ? { runtimeLease: JSON.parse(String(value.runtime_lease)) as JobSpec['lease'] }
          : {}),
        ...(typeof value.execution_deadline_at === 'number'
          ? { executionDeadlineAt: value.execution_deadline_at }
          : {}),
        ...(typeof value.worker_heartbeat_at === 'number'
          ? { workerHeartbeatAt: value.worker_heartbeat_at }
          : {}),
        ...(typeof value.cleanup_started_at === 'number'
          ? { cleanupStartedAt: value.cleanup_started_at }
          : {}),
        status: value.status as JobStatus,
        outputPath: value.output_path as string | null,
        contentHash: value.content_hash as string | null,
        error: value.error as string | null,
      }
    : null
}
function leaseMatches(expected: JobSpec['lease'], value: unknown) {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['expiresAt', 'fence', 'ownerId', 'token']) ||
    typeof value.ownerId !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.fence !== 'number' ||
    typeof value.expiresAt !== 'number'
  )
    return false
  const equalText = (left: string, right: string) =>
    left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  return (
    equalText(expected.ownerId, value.ownerId) &&
    equalText(expected.token, value.token) &&
    expected.fence === value.fence &&
    expected.expiresAt === value.expiresAt
  )
}
function leaseIdentityMatches(expected: JobSpec['lease'], value: unknown) {
  return (
    isRecord(value) &&
    typeof value.ownerId === 'string' &&
    typeof value.token === 'string' &&
    value.ownerId === expected.ownerId &&
    value.token === expected.token &&
    typeof value.fence === 'number'
  )
}
function isSafeDirectory(path: string, boundary: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe output directory')
  const real = realpathSync(path)
  if (real !== boundary && !real.startsWith(`${boundary}${sep}`))
    throw new Error('output escapes root')
  return real
}
function cliPreparationConfig(config: CliPreparationAdministratorConfig): string {
  if (
    !config ||
    !/^sha256:[a-f0-9]{64}$/.test(config.backendPolicyHash) ||
    typeof config.workspaceRoot !== 'string' ||
    typeof config.workspaceScope !== 'string' ||
    typeof config.credentialHome !== 'string' ||
    !Array.isArray(config.adapters) ||
    config.adapters.length === 0 ||
    new Set(config.adapters.map((adapter) => adapter.deviceId)).size !== config.adapters.length ||
    config.adapters.some(
      (adapter) =>
        !validText(adapter.deviceId) ||
        !validText(adapter.id) ||
        !['codex-exec', 'claude-print'].includes(adapter.kind) ||
        typeof adapter.executable !== 'string' ||
        !adapter.executable ||
        /[\0\r\n]/.test(adapter.executable) ||
        !/^sha256:[a-f0-9]{64}$/.test(adapter.binaryHash) ||
        typeof adapter.model !== 'string' ||
        !adapter.model ||
        adapter.model.length > 256,
    )
  )
    throw new Error('invalid CLI preparation administrator configuration')
  const boundAdapters = config.adapters.map((adapter) => ({
    ...adapter,
    // Resolve an administrator's PATH symlink once at startup. The worker receives
    // this immutable binary path and re-hashes it immediately before launch.
    executable: realpathSync(adapter.executable),
  }))
  for (const adapter of boundAdapters) {
    if (cliPreparationExecutableHash(adapter.executable) !== adapter.binaryHash)
      throw new Error('CLI preparation executable has changed')
  }
  return JSON.stringify({ ...config, adapters: boundAdapters })
}

export class JobDaemon implements JobDaemonPort {
  readonly trackingPolicyHash: string | undefined
  private readonly trackingConfigJson: string | undefined
  private readonly cliPreparationConfigJson: string | undefined
  private readonly cliPreparationConfig: CliPreparationAdministratorConfig | undefined
  private formalOciConfigJson: string | undefined
  private formalOci: FormalOciAdapter | undefined
  private readonly db: Database
  private server: ReturnType<typeof Bun.serve> | null = null
  private endpointToken: string | null = null
  private readonly workers = new Map<string, Bun.Subprocess>()
  private readonly escalationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false
  readonly outputRoot: string
  private readonly outputRootRealpath: string
  private readonly executionRuntimeMs: number | undefined
  private readonly renewalMs: number
  private readonly watchdog: ReturnType<typeof setInterval>
  private readonly processProbe: ProcessProbe
  private readonly authorityEpoch: string

  constructor(opts: {
    dbPath: string
    outputRoot: string
    tracking?: RunnerTrackingConfig
    cliPreparation?: CliPreparationAdministratorConfig
    /** Linux-only administrator admission; absence means v4 formal jobs are refused. */
    formalOci?: FormalOciAdministratorConfig
    /** Enables a deadline independent of a short, renewable v1 observation lease. */
    executionRuntimeMs?: number
    renewalMs?: number
    /** Injectable so restart and PID-reuse handling can be tested without signalling arbitrary PIDs. */
    processProbe?: ProcessProbe
  }) {
    if (opts.tracking) {
      const captured = captureRunnerTracking(opts.tracking)
      this.trackingPolicyHash = captured.policyHash
      this.trackingConfigJson = JSON.stringify(captured.config)
    }
    if (opts.cliPreparation) {
      this.cliPreparationConfigJson = cliPreparationConfig(opts.cliPreparation)
      this.cliPreparationConfig = JSON.parse(
        this.cliPreparationConfigJson,
      ) as CliPreparationAdministratorConfig
    }
    if (opts.formalOci) {
      this.formalOciConfigJson = JSON.stringify(opts.formalOci)
      this.formalOci = new FormalOciAdapter(opts.formalOci)
    }
    mkdirSync(resolve(opts.outputRoot), { recursive: true })
    this.outputRoot = resolve(opts.outputRoot)
    const rootStat = lstatSync(this.outputRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe output root')
    this.outputRootRealpath = realpathSync(this.outputRoot)
    if (
      opts.executionRuntimeMs !== undefined &&
      (!Number.isSafeInteger(opts.executionRuntimeMs) || opts.executionRuntimeMs < 1)
    )
      throw new Error('invalid execution runtime')
    if (
      opts.renewalMs !== undefined &&
      (!Number.isSafeInteger(opts.renewalMs) || opts.renewalMs < 1)
    )
      throw new Error('invalid renewal interval')
    this.executionRuntimeMs = opts.executionRuntimeMs
    this.renewalMs = opts.renewalMs ?? 15_000
    this.processProbe = opts.processProbe ?? { startIdentity: platformProcessStartIdentity }
    this.db = new Database(opts.dbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS local_jobs (dispatch_key TEXT PRIMARY KEY, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL, output_path TEXT, content_hash TEXT, error TEXT)',
    )
    const columns = this.db.query('PRAGMA table_info(local_jobs)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'worker_pid'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN worker_pid INTEGER')
    if (!columns.some((c) => c.name === 'runtime_lease'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN runtime_lease TEXT')
    if (!columns.some((c) => c.name === 'execution_deadline_at'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN execution_deadline_at INTEGER')
    if (!columns.some((c) => c.name === 'worker_heartbeat_at'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN worker_heartbeat_at INTEGER')
    if (!columns.some((c) => c.name === 'worker_pgid'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN worker_pgid INTEGER')
    if (!columns.some((c) => c.name === 'worker_start_identity'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN worker_start_identity TEXT')
    if (!columns.some((c) => c.name === 'cleanup_started_at'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN cleanup_started_at INTEGER')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS authority_identity (singleton INTEGER PRIMARY KEY CHECK (singleton=1), epoch TEXT NOT NULL)',
    )
    this.db
      .query(
        'INSERT INTO authority_identity (singleton,epoch) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING',
      )
      .run(randomBytes(32).toString('base64url'))
    const authority = this.db
      .query('SELECT epoch FROM authority_identity WHERE singleton=1')
      .get() as { epoch: string } | null
    if (!authority || !/^[A-Za-z0-9_-]{16,128}$/.test(authority.epoch))
      throw new Error('invalid durable authority epoch')
    this.authorityEpoch = authority.epoch
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS authority_closure_tombstones (dispatch_key TEXT PRIMARY KEY, spec_hash TEXT NOT NULL, expected_epoch TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at INTEGER NOT NULL)',
    )
    // Authority-owned watchdog: localhost jobs must not depend on a reconnecting observer.
    this.watchdog = setInterval(() => {
      if (!this.closed) {
        this.enforceRuntimeLimits()
        this.reconcileInterrupted()
      }
    }, 250)
  }
  async registerFormalCandidate(input: {
    candidateArtifactId: string
    code: Uint8Array
    codeHash: string
    candidateReceipt: Uint8Array
    candidateReceiptHash: string
  }) {
    if (!this.formalOci) throw new Error('formal OCI is not admitted')
    await this.formalOci.registerCandidate(input)
    this.formalOciConfigJson = JSON.stringify(this.formalOci.snapshotConfig())
  }

  submit(input: unknown, expectedEpoch?: string): DurableJob {
    const spec = parse(input)
    if ((spec.version === 3 || isFormalOciJob(spec)) && expectedEpoch === undefined)
      throw new Error('epoch-bound submission requires an authority epoch')
    if (expectedEpoch !== undefined && expectedEpoch !== this.authorityEpoch)
      throw new Error('authority epoch does not match')
    if (isFormalOciJob(spec)) {
      if (spec.execution.authorityEpoch !== this.authorityEpoch)
        throw new Error('formal OCI authority epoch does not match')
      if (!this.formalOci) throw new Error('formal OCI is not admitted')
      // Candidate/data bytes are deliberately revalidated by the isolated formal
      // worker immediately before execution.  Hashing a multi-GB dataset here
      // would block the authority event loop and let unrelated runtime leases expire.
    } else if (!isCliPreparationJob(spec)) {
      if (spec.trackingPolicyHash !== this.trackingPolicyHash)
        throw new Error('Tracking startup policy does not match JobSpec')
      const plan = fixedResearchTemplate(spec.templateId)
      if ((plan.inputHash?.() ?? plan.execute().inputHash) !== spec.inputHash)
        throw new Error('fixed_template_input_hash_mismatch')
    } else {
      if (spec.backendPolicyHash !== this.cliPreparationConfig?.backendPolicyHash)
        throw new Error('CLI preparation backend policy has changed')
      const adapter = this.cliPreparationConfig?.adapters.find(
        (candidate) =>
          candidate.deviceId === spec.execution.deviceId &&
          candidate.id === spec.execution.adapterId &&
          candidate.model === spec.execution.model,
      )
      if (!adapter) throw new Error('CLI preparation adapter is not admitted')
      if (spec.execution.adapterConfigHash !== cliPreparationAdapterConfigHash(adapter))
        throw new Error('CLI preparation adapter configuration has changed')
    }
    const specHash = hash(spec)
    const inserted = this.immediateTransaction(() => {
      // This is deliberately inside the write transaction with the insert.  An
      // identity read by a controller is only an observation; the authority that
      // durably accepts work must also prove it is still that same epoch.
      if (expectedEpoch !== undefined && expectedEpoch !== this.authorityEpoch)
        throw new Error('authority epoch does not match')
      if (
        this.db
          .query('SELECT 1 FROM authority_closure_tombstones WHERE dispatch_key=?')
          .get(spec.dispatchKey)
      )
        throw new Error('dispatch_key_closed')
      return this.db
        .query(
          'INSERT INTO local_jobs (dispatch_key,spec,spec_hash,status,output_path,content_hash,error,runtime_lease,execution_deadline_at,worker_heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dispatch_key) DO NOTHING',
        )
        .run(
          spec.dispatchKey,
          canonical(spec),
          specHash,
          'queued',
          null,
          null,
          null,
          canonical(spec.lease),
          // v1 has no approved runtime budget: configuration may tighten, never enlarge its frozen expiry.
          Math.min(
            isFormalOciJob(spec)
              ? Date.now() + spec.formalPlan.resources.maxRuntimeMs
              : isCliPreparationJob(spec)
                ? Date.now() + spec.execution.maxRuntimeMs
                : spec.version === 2
                  ? Date.now() + spec.execution!.maxRuntimeMs
                  : spec.lease.expiresAt,
            this.executionRuntimeMs === undefined ? Infinity : Date.now() + this.executionRuntimeMs,
          ),
          null,
        )
    })
    const job = this.query(spec.dispatchKey)
    if (!job) throw new Error('job insert failed')
    if (inserted.changes === 0 && job.specHash !== specHash)
      throw new Error('dispatch_key_conflict')
    return job
  }
  query(dispatchKey: string): DurableJob | null {
    return row(
      this.db.query('SELECT * FROM local_jobs WHERE dispatch_key = ?').get(dispatchKey) as Record<
        string,
        unknown
      > | null,
    )
  }
  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A failed BEGIN has no transaction to roll back.
      }
      throw error
    }
  }
  identity(): ResearchAuthorityIdentity {
    return { schema: 'research-authority-identity-v1', epoch: this.authorityEpoch }
  }
  closeUnstarted(input: unknown): ResearchAuthorityClosureProof {
    const request = closureRequest(input)
    if (request.expectedEpoch !== this.authorityEpoch)
      throw new Error('authority epoch does not match')
    const tombstone = this.immediateTransaction(() => {
      const existing = this.db
        .query(
          'SELECT spec_hash,expected_epoch,outcome,recorded_at FROM authority_closure_tombstones WHERE dispatch_key=?',
        )
        .get(request.dispatchKey) as {
        spec_hash: string
        expected_epoch: string
        outcome: ResearchAuthorityClosureProof['outcome']
        recorded_at: number
      } | null
      if (existing) {
        if (
          existing.spec_hash !== request.specHash ||
          existing.expected_epoch !== request.expectedEpoch
        )
          throw new Error('authority closure tombstone conflicts')
        return {
          schema: 'research-authority-closure-v1' as const,
          ...request,
          outcome: existing.outcome,
          recordedAt: existing.recorded_at,
        }
      }
      const job = this.query(request.dispatchKey)
      if (job) {
        if (job.specHash !== request.specHash) throw new Error('authority closure job conflicts')
        return null
      }
      const proof: ResearchAuthorityClosureProof = {
        schema: 'research-authority-closure-v1',
        ...request,
        outcome: 'not_started',
        recordedAt: Date.now(),
      }
      this.db
        .query(
          'INSERT INTO authority_closure_tombstones (dispatch_key,spec_hash,expected_epoch,outcome,recorded_at) VALUES (?,?,?,?,?)',
        )
        .run(
          proof.dispatchKey,
          proof.specHash,
          proof.expectedEpoch,
          proof.outcome,
          proof.recordedAt,
        )
      return proof
    })
    if (tombstone) return tombstone
    let job = this.query(request.dispatchKey)
    if (!job || job.specHash !== request.specHash)
      throw new Error('authority closure changed during handling')
    if (job.status === 'queued' || job.status === 'running')
      job = this.cancel(request.dispatchKey, request.expectedEpoch)
    if (job?.status === 'completion_requested') this.reconcileInterrupted()
    job = this.query(request.dispatchKey)
    if (!job || job.specHash !== request.specHash)
      throw new Error('authority closure changed during handling')
    if (job.status === 'queued' || job.status === 'running')
      throw new Error('authority close did not persist intent')
    return {
      schema: 'research-authority-closure-v1',
      ...request,
      outcome: job.status,
      recordedAt: Date.now(),
    }
  }
  cancel(dispatchKey: string, expectedEpoch?: string): DurableJob | null {
    const job = this.immediateTransaction(() => {
      const current = row(
        this.db.query('SELECT * FROM local_jobs WHERE dispatch_key = ?').get(dispatchKey) as Record<
          string,
          unknown
        > | null,
      )
      if (!current) return null
      if (
        (current.spec.version === 3 || isFormalOciJob(current.spec)) &&
        expectedEpoch === undefined
      )
        throw new Error('epoch-bound cancellation requires an authority epoch')
      if (expectedEpoch !== undefined && expectedEpoch !== this.authorityEpoch)
        throw new Error('authority epoch does not match')
      if (current.status === 'queued')
        this.db
          .query(
            "UPDATE local_jobs SET status='cancelled' WHERE dispatch_key=? AND status='queued'",
          )
          .run(dispatchKey)
      if (current.status === 'running' || current.status === 'completion_requested')
        this.db
          .query(
            "UPDATE local_jobs SET status='cancel_requested' WHERE dispatch_key=? AND status IN ('running','completion_requested')",
          )
          .run(dispatchKey)
      return current
    })
    if (!job) return null
    // The request is durable before any signal. Repeating cancel after a crash is
    // deliberately recovery, not a new grace period.
    if (this.query(dispatchKey)?.status === 'cancel_requested') this.recoverCleanup(dispatchKey)
    return this.query(dispatchKey)
  }
  reconcileInterrupted(): DurableJob[] {
    const candidates = this.db
      .query(
        "SELECT dispatch_key,status,worker_pid,worker_pgid,worker_start_identity,execution_deadline_at,runtime_lease FROM local_jobs WHERE status IN ('running','cancel_requested','completion_requested')",
      )
      .all() as {
      dispatch_key: string
      status: string
      worker_pid: number | null
      worker_pgid: number | null
      worker_start_identity: string | null
      execution_deadline_at: number | null
      runtime_lease: string | null
    }[]
    for (const candidate of candidates) {
      // A verified receipt is durable authority state. Its group still needs
      // reaping, but an elapsed execution budget cannot rewrite it into a cancel.
      if (
        candidate.status === 'running' &&
        candidate.execution_deadline_at !== null &&
        Date.now() >= candidate.execution_deadline_at
      )
        this.cancel(candidate.dispatch_key, this.authorityEpoch)
      if (candidate.status === 'cancel_requested' || candidate.status === 'completion_requested')
        this.recoverCleanup(candidate.dispatch_key)
      if (!candidate.worker_pid || !candidate.worker_start_identity) continue
      const identity = this.processIdentityState(
        candidate.worker_pid,
        candidate.worker_start_identity,
      )
      // PID reuse and failed process inspection are not evidence that this job's
      // worker has stopped.  Keep the authority state pending for an operator or
      // a later observable transition.
      if (identity === 'match' || identity === 'mismatch' || identity === 'unknown') continue
      if (candidate.worker_pgid && this.processGroupAlive(candidate.worker_pgid)) continue
      this.db
        .query('UPDATE local_jobs SET status=?, error=? WHERE dispatch_key=? AND status=?')
        .run(
          candidate.status === 'cancel_requested'
            ? 'cancelled'
            : candidate.status === 'completion_requested'
              ? 'completed'
              : 'interrupted',
          candidate.status === 'completion_requested'
            ? null
            : 'worker process exit confirmed; no automatic redispatch',
          candidate.dispatch_key,
          candidate.status,
        )
    }
    return this.db
      .query("SELECT * FROM local_jobs WHERE status='interrupted'")
      .all()
      .map((value) => row(value as Record<string, unknown>)!)
  }
  private claim(key: string, lease: unknown, workerPid: unknown): DurableJob | null {
    const job = this.query(key)
    if (
      !job ||
      job.status !== 'queued' ||
      typeof workerPid !== 'number' ||
      !Number.isSafeInteger(workerPid) ||
      workerPid < 1 ||
      Date.now() >= (job.executionDeadlineAt ?? job.spec.lease.expiresAt) ||
      Date.now() >= (job.runtimeLease ?? job.spec.lease).expiresAt ||
      !leaseMatches(job.runtimeLease ?? job.spec.lease, lease)
    )
      return null
    const workerStartIdentity = this.processProbe.startIdentity(workerPid)
    const launched = this.workers.get(key)
    const updated = this.db
      .query(
        "UPDATE local_jobs SET status='running', worker_pid=?, worker_pgid=?, worker_start_identity=?, worker_heartbeat_at=? WHERE dispatch_key=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM local_jobs WHERE status IN ('running','cancel_requested'))",
      )
      .run(
        workerPid,
        launched?.pid === workerPid && process.platform !== 'win32' ? workerPid : null,
        workerStartIdentity,
        Date.now(),
        key,
      )
    return updated.changes === 1 ? this.query(key) : null
  }
  private renew(key: string, lease: unknown): DurableJob | null {
    const job = this.query(key)
    const deadline = job?.executionDeadlineAt ?? job?.spec.lease.expiresAt
    const current = job?.runtimeLease ?? job?.spec.lease
    if (
      !job ||
      !current ||
      job.status !== 'running' ||
      !deadline ||
      Date.now() >= deadline ||
      Date.now() >= current.expiresAt
    )
      return null
    // A response can be lost after the authority commits renewal. Replaying the immediately
    // preceding generation returns the current lease instead of stranding the same worker.
    if (!leaseMatches(current, lease)) {
      if (
        leaseIdentityMatches(current, lease) &&
        (lease as { fence: number }).fence === current.fence - 1
      )
        return job
      return null
    }
    const renewed = {
      ...current,
      fence: current.fence + 1,
      expiresAt: Math.min(deadline, Date.now() + this.renewalMs),
    }
    this.db
      .query(
        "UPDATE local_jobs SET runtime_lease=?, worker_heartbeat_at=? WHERE dispatch_key=? AND status='running'",
      )
      .run(canonical(renewed), Date.now(), key)
    return this.query(key)
  }
  private cancelAcknowledged(key: string, lease: unknown): DurableJob | null {
    const job = this.query(key)
    if (
      !job ||
      job.status !== 'cancel_requested' ||
      !leaseMatches(job.runtimeLease ?? job.spec.lease, lease)
    )
      return null
    const identity = this.db
      .query(
        'SELECT worker_pid,worker_pgid,worker_start_identity FROM local_jobs WHERE dispatch_key=?',
      )
      .get(key) as {
      worker_pid: number | null
      worker_pgid: number | null
      worker_start_identity: string | null
    } | null
    if (!identity?.worker_pid || !identity.worker_start_identity) return job
    if (
      this.processIdentityState(identity.worker_pid, identity.worker_start_identity) !== 'missing'
    )
      return job
    if (identity.worker_pgid && this.processGroupAlive(identity.worker_pgid)) return job
    this.db
      .query(
        "UPDATE local_jobs SET status='cancelled' WHERE dispatch_key=? AND status='cancel_requested'",
      )
      .run(key)
    return this.query(key)
  }
  private async verifiedOutput(
    job: DurableJob,
    result: unknown,
  ): { contentHash: string; outputPath: string } | null {
    if (
      !isRecord(result) ||
      !hasKeys(result, ['contentHash', 'outputPath']) ||
      typeof result.contentHash !== 'string' ||
      typeof result.outputPath !== 'string'
    )
      return null
    const formal = isFormalOciJob(job.spec)
    const baseSpec = job.spec as DaemonJobSpec
    const plan =
      formal || isCliPreparationJob(baseSpec) ? null : fixedResearchTemplate(baseSpec.templateId)
    const expected = resolve(
      this.outputRoot,
      job.spec.dispatchKey,
      formal ? 'formal-receipt.json' : plan ? plan.filename : 'candidate.json',
    )
    if (result.outputPath !== expected) return null
    try {
      const directory = join(this.outputRoot, job.spec.dispatchKey)
      const realDirectory = isSafeDirectory(directory, this.outputRootRealpath)
      const stat = lstatSync(expected)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        !realpathSync(expected).startsWith(`${realDirectory}${sep}`)
      )
        return null
      const bytes = readFileSync(expected)
      if (
        (isCliPreparationJob(baseSpec) || formal) &&
        bytes.byteLength > MAX_CLI_PREPARATION_RECEIPT_BYTES
      )
        return null
      const contentHash = hashBytes(bytes)
      if (contentHash !== result.contentHash) return null
      if (isCliPreparationJob(baseSpec)) {
        if (!verifyCandidateReceipt(JSON.parse(bytes.toString()), baseSpec)) return null
      } else if (formal) {
        if (!(await this.verifyFormalReceipt(job.spec as FormalOciJobSpec, directory, bytes)))
          return null
      } else {
        fixedResearchTemplate(baseSpec.templateId).verify(bytes)
        verifyTrackingBinding(bytes, baseSpec)
      }
      return { contentHash, outputPath: expected }
    } catch {
      return null
    }
  }
  async verifyFormalReceipt(
    job: FormalOciJobSpec,
    directory: string,
    bytes: Uint8Array,
  ): Promise<boolean> {
    if (!this.formalOciConfigJson) return false
    try {
      return await verifyFormalReceiptInThread(
        JSON.parse(this.formalOciConfigJson) as FormalOciAdministratorConfig,
        job,
        directory,
        bytes,
      )
    } catch {
      return false
    }
  }
  private async finish(key: string, lease: unknown, result: unknown): Promise<DurableJob | null> {
    const job = this.query(key)
    if (
      !job ||
      job.status !== 'running' ||
      Date.now() >= (job.executionDeadlineAt ?? job.spec.lease.expiresAt) ||
      Date.now() >= (job.runtimeLease ?? job.spec.lease).expiresAt ||
      !leaseMatches(job.runtimeLease ?? job.spec.lease, lease)
    )
      return null
    const verified = await this.verifiedOutput(job, result)
    if (!verified) return null
    const current = this.query(key)
    if (
      !current ||
      current.status !== 'running' ||
      Date.now() >= (current.executionDeadlineAt ?? current.spec.lease.expiresAt) ||
      Date.now() >= (current.runtimeLease ?? current.spec.lease).expiresAt ||
      !leaseMatches(current.runtimeLease ?? current.spec.lease, lease)
    )
      return null
    this.db
      .query(
        "UPDATE local_jobs SET status='completion_requested', content_hash=?, output_path=? WHERE dispatch_key=? AND status='running'",
      )
      .run(verified.contentHash, verified.outputPath, key)
    const completion = this.query(key)
    // A CLI may exit while a deliberately detached descendant survives with all
    // standard streams closed. Keep the receipt durable, then terminate the
    // verified job group before treating that receipt as a completed authority run.
    if (completion && completion.spec.version === 3) this.recoverCleanup(key)
    return completion
  }
  private authorized(request: Request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
    return Boolean(
      this.endpointToken &&
        token &&
        token.length === this.endpointToken.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(this.endpointToken)),
    )
  }
  hasAvailableSlot(): boolean {
    return !this.db
      .query(
        "SELECT 1 FROM local_jobs WHERE status IN ('running','cancel_requested','completion_requested') LIMIT 1",
      )
      .get()
  }
  pendingJobs(): DurableJob[] {
    return (
      this.db
        .query(
          "SELECT dispatch_key FROM local_jobs WHERE status IN ('queued','running','cancel_requested','completion_requested') ORDER BY rowid",
        )
        .all() as Array<{ dispatch_key: string }>
    )
      .map((row) => this.query(row.dispatch_key)!)
      .filter(Boolean)
  }
  /** Deadline/lease authority lives here, never in a reconnecting observer. */
  enforceRuntimeLimits(): void {
    for (const job of this.pendingJobs()) {
      const deadline = job.executionDeadlineAt ?? job.spec.lease.expiresAt
      const lease = job.runtimeLease ?? job.spec.lease
      if (job.status === 'queued' && (Date.now() >= deadline || Date.now() >= lease.expiresAt))
        this.cancel(job.spec.dispatchKey, this.authorityEpoch)
      if (job.status === 'running' && (Date.now() >= deadline || Date.now() >= lease.expiresAt))
        this.cancel(job.spec.dispatchKey, this.authorityEpoch)
    }
  }
  receipt(dispatchKey: string): Uint8Array {
    const job = this.query(dispatchKey)
    if (
      !job ||
      job.status !== 'completed' ||
      !this.verifiedOutput(job, { contentHash: job.contentHash, outputPath: job.outputPath })
    )
      throw new Error('Verified daemon receipt unavailable')
    return readFileSync(job.outputPath!)
  }
  private processIdentityState(pid: number, recorded: string): ProcessIdentityState {
    const current = this.processProbe.startIdentity(pid)
    if (current !== null) return current === recorded ? 'match' : 'mismatch'
    try {
      process.kill(pid, 0)
      return 'unknown'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unknown'
    }
  }
  private signalOwnedWorker(
    identity: {
      worker_pid: number | null
      worker_pgid: number | null
      worker_start_identity: string | null
    },
    signal: NodeJS.Signals,
  ): boolean {
    if (
      !identity.worker_pid ||
      !identity.worker_start_identity ||
      this.processIdentityState(identity.worker_pid, identity.worker_start_identity) !== 'match'
    )
      return false
    // The process group is associated with this job only while its recorded
    // leader still has the same start identity.  Once the leader exits, an
    // extant PGID could no longer be attributed safely and is left pending.
    if (!identity.worker_pgid || process.platform === 'win32') return false
    try {
      process.kill(-identity.worker_pgid, signal)
      return true
    } catch {
      return false
    }
  }
  private persistedWorkerIdentity(dispatchKey: string) {
    return this.db
      .query(
        'SELECT worker_pid,worker_pgid,worker_start_identity FROM local_jobs WHERE dispatch_key=?',
      )
      .get(dispatchKey) as {
      worker_pid: number | null
      worker_pgid: number | null
      worker_start_identity: string | null
    } | null
  }
  /**
   * Rebuild the authority-owned TERM→KILL cleanup after a restart.  Its deadline
   * is persisted before signalling, so watchdog polls and repeated recovery never
   * buy a TERM-ignoring child another grace period.  A missing or changed leader
   * is intentionally left pending: a PGID is only safe while its recorded leader
   * still proves ownership.
   */
  private recoverCleanup(dispatchKey: string) {
    let job = this.query(dispatchKey)
    if (job?.status !== 'cancel_requested' && job?.status !== 'completion_requested') return
    if (job.cleanupStartedAt === undefined) {
      this.db
        .query(
          "UPDATE local_jobs SET cleanup_started_at=? WHERE dispatch_key=? AND status IN ('cancel_requested','completion_requested') AND cleanup_started_at IS NULL",
        )
        .run(Date.now(), dispatchKey)
      job = this.query(dispatchKey)
      if (job?.status !== 'cancel_requested' && job?.status !== 'completion_requested') return
    }
    const startedAt = job.cleanupStartedAt
    if (startedAt === undefined) return
    if (isFormalOciJob(job.spec) && !this.formalOci?.stopAndConfirm(job.spec)) return
    const remainingMs = startedAt + 250 - Date.now()
    const existing = this.escalationTimers.get(dispatchKey)
    if (remainingMs <= 0) {
      if (existing) {
        clearTimeout(existing)
        this.escalationTimers.delete(dispatchKey)
      }
      const identity = this.persistedWorkerIdentity(dispatchKey)
      if (identity) this.signalOwnedWorker(identity, 'SIGKILL')
      return
    }
    // A timer already uses the immutable persisted deadline. Do not reset it.
    if (existing) return
    const identity = this.persistedWorkerIdentity(dispatchKey)
    if (!identity || !this.signalOwnedWorker(identity, 'SIGTERM')) return
    const timer = setTimeout(() => {
      this.escalationTimers.delete(dispatchKey)
      this.recoverCleanup(dispatchKey)
    }, remainingMs)
    this.escalationTimers.set(dispatchKey, timer)
  }
  private processGroupAlive(pgid: number): boolean {
    if (process.platform === 'win32') return true // conservative: only worker exit can prove termination.
    try {
      process.kill(-pgid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  startHttp(): JobDaemonEndpoint {
    if (this.server && this.endpointToken)
      return { endpoint: `http://127.0.0.1:${this.server.port}`, token: this.endpointToken }
    this.endpointToken = randomBytes(32).toString('base64url')
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        if (!this.authorized(request)) return new Response('unauthorized', { status: 401 })
        const url = new URL(request.url)
        const key = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        if (!validText(key)) return new Response('not found', { status: 404 })
        if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
          const job = this.query(key)
          return Response.json(job ?? { status: 'unknown' }, { status: job ? 200 : 404 })
        }
        const body = await request.json().catch(() => null)
        if (request.method === 'POST') {
          const lease = isRecord(body) ? body.lease : null
          const result = url.pathname.startsWith('/claim/')
            ? this.claim(key, lease, isRecord(body) ? body.workerPid : null)
            : url.pathname.startsWith('/renew/')
              ? this.renew(key, lease)
              : url.pathname.startsWith('/finish/')
                ? await this.finish(key, lease, isRecord(body) ? body.result : null)
                : url.pathname.startsWith('/cancelled/')
                  ? this.cancelAcknowledged(key, lease)
                  : null
          return Response.json(result ?? { error: 'operation_rejected' }, {
            status: result ? 200 : 409,
          })
        }
        return new Response('not found', { status: 404 })
      },
    })
    return { endpoint: `http://127.0.0.1:${this.server.port}`, token: this.endpointToken }
  }
  stopHttp() {
    this.server?.stop(true)
    this.server = null
    this.endpointToken = null
  }
  async launchWorker(
    dispatchKey: string,
    options: { waitAfterClaim?: boolean; workerArgv?: readonly string[] } = {},
  ): Promise<Bun.Subprocess> {
    const running = this.workers.get(dispatchKey)
    if (running) return running
    const { endpoint, token } = this.startHttp()
    const worker = join(import.meta.dir, 'job-daemon-worker.ts')
    const launcher = options.workerArgv ? [...options.workerArgv] : [process.execPath, worker]
    if (launcher.length === 0) throw new Error('worker launcher is required')
    const child = Bun.spawn([...launcher, endpoint, dispatchKey, this.outputRoot, token], {
      stdin: this.trackingConfigJson ? new Blob([this.trackingConfigJson]) : 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: {
        ...Object.fromEntries(
          ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
        ...(options.waitAfterClaim ? { JOB_DAEMON_WORKER_WAIT_AFTER_CLAIM: '1' } : {}),
        ...(this.trackingConfigJson ? { OPH_RESEARCH_TRACKING_STDIN: '1' } : {}),
        ...(this.cliPreparationConfigJson
          ? { OPH_CLI_PREPARATION_ADMIN_CONFIG: this.cliPreparationConfigJson }
          : {}),
        ...(this.formalOciConfigJson
          ? { OPH_FORMAL_OCI_ADMIN_CONFIG: this.formalOciConfigJson }
          : {}),
      },
      detached: process.platform !== 'win32',
    })
    this.workers.set(dispatchKey, child)
    void child.exited.then(() => {
      this.workers.delete(dispatchKey)
      if (this.closed) return
      const job = this.query(dispatchKey)
      if (job?.status === 'cancel_requested')
        this.cancelAcknowledged(dispatchKey, job.runtimeLease ?? job.spec.lease)
      if (job?.status === 'completion_requested') this.reconcileInterrupted()
    })
    return child
  }
  /** `terminateWorkers: false` models an authority crash for restart-recovery tests. */
  close(options: { terminateWorkers?: boolean } = {}) {
    this.closed = true
    clearInterval(this.watchdog)
    if (options.terminateWorkers !== false) {
      for (const [key, child] of this.workers) {
        // Shutdown cannot rely on an escalation timer after its database closes.
        // A confirmed group leader authorizes an immediate whole-tree KILL.
        const identity = this.persistedWorkerIdentity(key)
        if (identity) this.signalOwnedWorker(identity, 'SIGKILL')
        // This exact child is also safe to kill as the platform fallback.
        child.kill('SIGKILL')
      }
    }
    this.workers.clear()
    for (const timer of this.escalationTimers.values()) clearTimeout(timer)
    this.escalationTimers.clear()
    this.stopHttp()
    this.db.close()
  }
}
