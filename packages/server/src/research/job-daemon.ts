import { Database } from 'bun:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ResearchTemplateId } from '@oph-autoresearch/core'
import {
  captureRunnerTracking,
  type RunnerTrackingConfig,
  verifyTrackingBinding,
} from './runner-tracking.ts'
import { fixedResearchTemplate } from './template-registry.ts'

export type JobTemplate = ResearchTemplateId
export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
export interface JobSpec {
  backendPolicyHash?: string
  trackingPolicyHash?: string
  version: 1
  dispatchKey: string
  campaignId: string
  taskRevisionId: string
  templateId: JobTemplate
  inputHash: string
  resource: { cpu: 1; memoryMb: number }
  lease: { ownerId: string; token: string; fence: number; expiresAt: number }
}
export interface DurableJob {
  spec: JobSpec
  specHash: string
  status: JobStatus
  outputPath: string | null
  contentHash: string | null
  error: string | null
}
export interface JobDaemonPort {
  submit(spec: unknown): DurableJob
  query(dispatchKey: string): DurableJob | null
  cancel(dispatchKey: string): DurableJob | null
}
export interface JobDaemonEndpoint {
  endpoint: string
  token: string
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
function hash(value: unknown) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}
function hashBytes(value: Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
function validText(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function parse(value: unknown): JobSpec {
  if (!isRecord(value)) throw new Error('invalid JobSpec')
  if (
    !hasKeys(value, [
      ...(value.trackingPolicyHash === undefined ? [] : ['trackingPolicyHash']),
      ...(value.backendPolicyHash === undefined ? [] : ['backendPolicyHash']),
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
    value.version !== 1 ||
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
  return value as unknown as JobSpec
}
function row(value: Record<string, unknown> | null): DurableJob | null {
  return value
    ? {
        spec: JSON.parse(String(value.spec)) as JobSpec,
        specHash: String(value.spec_hash),
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
function isSafeDirectory(path: string, boundary: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe output directory')
  const real = realpathSync(path)
  if (real !== boundary && !real.startsWith(`${boundary}${sep}`))
    throw new Error('output escapes root')
  return real
}

export class JobDaemon implements JobDaemonPort {
  readonly trackingPolicyHash: string | undefined
  private readonly trackingConfigJson: string | undefined
  private readonly db: Database
  private server: ReturnType<typeof Bun.serve> | null = null
  private endpointToken: string | null = null
  private readonly workers = new Map<string, Bun.Subprocess>()
  private closed = false
  readonly outputRoot: string
  private readonly outputRootRealpath: string

  constructor(opts: { dbPath: string; outputRoot: string; tracking?: RunnerTrackingConfig }) {
    if (opts.tracking) {
      const captured = captureRunnerTracking(opts.tracking)
      this.trackingPolicyHash = captured.policyHash
      this.trackingConfigJson = JSON.stringify(captured.config)
    }
    mkdirSync(resolve(opts.outputRoot), { recursive: true })
    this.outputRoot = resolve(opts.outputRoot)
    const rootStat = lstatSync(this.outputRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe output root')
    this.outputRootRealpath = realpathSync(this.outputRoot)
    this.db = new Database(opts.dbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS local_jobs (dispatch_key TEXT PRIMARY KEY, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL, output_path TEXT, content_hash TEXT, error TEXT)',
    )
    const columns = this.db.query('PRAGMA table_info(local_jobs)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'worker_pid'))
      this.db.exec('ALTER TABLE local_jobs ADD COLUMN worker_pid INTEGER')
  }
  submit(input: unknown): DurableJob {
    const spec = parse(input)
    if (spec.trackingPolicyHash !== this.trackingPolicyHash)
      throw new Error('Tracking startup policy does not match JobSpec')
    const plan = fixedResearchTemplate(spec.templateId)
    if (plan.execute().inputHash !== spec.inputHash)
      throw new Error('fixed_template_input_hash_mismatch')
    const specHash = hash(spec)
    const inserted = this.db
      .query(
        'INSERT INTO local_jobs (dispatch_key,spec,spec_hash,status,output_path,content_hash,error) VALUES (?,?,?,?,?,?,?) ON CONFLICT(dispatch_key) DO NOTHING',
      )
      .run(spec.dispatchKey, canonical(spec), specHash, 'queued', null, null, null)
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
  cancel(dispatchKey: string): DurableJob | null {
    const job = this.query(dispatchKey)
    if (!job) return null
    if (job.status === 'queued')
      this.db
        .query("UPDATE local_jobs SET status='cancelled' WHERE dispatch_key=? AND status='queued'")
        .run(dispatchKey)
    if (job.status === 'running') {
      this.db
        .query(
          "UPDATE local_jobs SET status='cancel_requested' WHERE dispatch_key=? AND status='running'",
        )
        .run(dispatchKey)
      this.workers.get(dispatchKey)?.kill()
    }
    return this.query(dispatchKey)
  }
  reconcileInterrupted(): DurableJob[] {
    const candidates = this.db
      .query(
        "SELECT dispatch_key,status,worker_pid FROM local_jobs WHERE status IN ('running','cancel_requested')",
      )
      .all() as { dispatch_key: string; status: string; worker_pid: number | null }[]
    for (const candidate of candidates) {
      if (!candidate.worker_pid) continue // A missing process identity cannot prove termination.
      try {
        process.kill(candidate.worker_pid, 0)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
      this.db
        .query('UPDATE local_jobs SET status=?, error=? WHERE dispatch_key=? AND status=?')
        .run(
          candidate.status === 'cancel_requested' ? 'cancelled' : 'interrupted',
          'worker process exit confirmed; no automatic redispatch',
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
      Date.now() >= job.spec.lease.expiresAt ||
      !leaseMatches(job.spec.lease, lease)
    )
      return null
    const updated = this.db
      .query(
        "UPDATE local_jobs SET status='running', worker_pid=? WHERE dispatch_key=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM local_jobs WHERE status IN ('running','cancel_requested'))",
      )
      .run(workerPid, key)
    return updated.changes === 1 ? this.query(key) : null
  }
  private cancelAcknowledged(key: string, lease: unknown): DurableJob | null {
    const job = this.query(key)
    if (!job || job.status !== 'cancel_requested' || !leaseMatches(job.spec.lease, lease))
      return null
    const identity = this.db
      .query('SELECT worker_pid FROM local_jobs WHERE dispatch_key=?')
      .get(key) as { worker_pid: number | null } | null
    if (!identity?.worker_pid) return job
    try {
      process.kill(identity.worker_pid, 0)
      return job
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return job
    }
    this.db
      .query(
        "UPDATE local_jobs SET status='cancelled' WHERE dispatch_key=? AND status='cancel_requested'",
      )
      .run(key)
    return this.query(key)
  }
  private verifiedOutput(
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
    const plan = fixedResearchTemplate(job.spec.templateId)
    const expected = resolve(this.outputRoot, job.spec.dispatchKey, plan.filename)
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
      const contentHash = hashBytes(bytes)
      if (contentHash !== result.contentHash) return null
      plan.verify(bytes)
      verifyTrackingBinding(bytes, job.spec)
      return { contentHash, outputPath: expected }
    } catch {
      return null
    }
  }
  private finish(key: string, lease: unknown, result: unknown): DurableJob | null {
    const job = this.query(key)
    if (
      !job ||
      job.status !== 'running' ||
      Date.now() >= job.spec.lease.expiresAt ||
      !leaseMatches(job.spec.lease, lease)
    )
      return null
    const verified = this.verifiedOutput(job, result)
    if (!verified) return null
    this.db
      .query(
        "UPDATE local_jobs SET status='completed', content_hash=?, output_path=? WHERE dispatch_key=? AND status='running'",
      )
      .run(verified.contentHash, verified.outputPath, key)
    return this.query(key)?.status === 'completed' ? this.query(key) : null
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
      .query("SELECT 1 FROM local_jobs WHERE status IN ('running','cancel_requested') LIMIT 1")
      .get()
  }
  pendingJobs(): DurableJob[] {
    return (
      this.db
        .query(
          "SELECT dispatch_key FROM local_jobs WHERE status IN ('queued','running','cancel_requested') ORDER BY rowid",
        )
        .all() as Array<{ dispatch_key: string }>
    )
      .map((row) => this.query(row.dispatch_key)!)
      .filter(Boolean)
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
            : url.pathname.startsWith('/finish/')
              ? this.finish(key, lease, isRecord(body) ? body.result : null)
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
      },
    })
    this.workers.set(dispatchKey, child)
    void child.exited.then(() => {
      this.workers.delete(dispatchKey)
      if (this.closed) return
      const job = this.query(dispatchKey)
      if (job?.status === 'cancel_requested')
        this.db
          .query(
            "UPDATE local_jobs SET status='cancelled' WHERE dispatch_key=? AND status='cancel_requested'",
          )
          .run(dispatchKey)
    })
    return child
  }
  close() {
    this.closed = true
    for (const worker of this.workers.values()) worker.kill()
    this.workers.clear()
    this.stopHttp()
    this.db.close()
  }
}
