import { timingSafeEqual } from 'node:crypto'
import type { CliPreparationAdministratorConfig } from './cli-preparation-job.ts'
import type { FormalOciAdministratorConfig } from './formal-oci.ts'
import { type DurableJob, JobDaemon } from './job-daemon.ts'
import type { RunnerTrackingConfig } from './runner-tracking.ts'

/** Administrator-only startup configuration. Requests can select only admitted adapter identities. */
export interface RemoteDaemonServiceConfig {
  authorityId: string
  token: string
  port: number
  dbPath: string
  outputRoot: string
  workerArgv?: readonly string[]
  tracking?: RunnerTrackingConfig
  cliPreparation?: CliPreparationAdministratorConfig
  formalOci?: FormalOciAdministratorConfig
  executionRuntimeMs?: number
  renewalMs?: number
}
function projection(job: DurableJob | null) {
  return job ? { ...job, outputPath: null, error: job.error ? 'worker-failure' : null } : null
}
const CLOSURE_KEYS = ['dispatchKey', 'expectedEpoch', 'specHash'] as const
const SUBMISSION_KEYS = ['expectedEpoch', 'spec'] as const
function isClosureRequest(value: unknown): value is {
  dispatchKey: string
  expectedEpoch: string
  specHash: string
} {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>)
      .sort()
      .join(',') === CLOSURE_KEYS.join(',') &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(
      String((value as Record<string, unknown>).dispatchKey),
    ) &&
    /^[A-Za-z0-9_-]{16,128}$/.test(String((value as Record<string, unknown>).expectedEpoch)) &&
    /^sha256:[a-f0-9]{64}$/.test(String((value as Record<string, unknown>).specHash))
  )
}
function isEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
function isRecordWithExpectedEpoch(value: unknown): value is { expectedEpoch: string } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 1 &&
    isEpoch((value as Record<string, unknown>).expectedEpoch)
  )
}
function isSubmissionRequest(value: unknown): value is { expectedEpoch: string; spec: unknown } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>)
      .sort()
      .join(',') === SUBMISSION_KEYS.join(',') &&
    isEpoch((value as Record<string, unknown>).expectedEpoch) &&
    'spec' in (value as Record<string, unknown>)
  )
}
async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new Error('too_large')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('invalid')
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new Error('too_large')
    }
    chunks.push(result.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid')
  }
}
/** Long-lived remote authority: SSH only transports this bounded protocol; disconnect does not own the job. */
export function createRemoteDaemonService(config: RemoteDaemonServiceConfig) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.authorityId) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(config.token) ||
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  )
    throw new Error('Invalid remote daemon startup configuration')
  const authorityId = config.authorityId,
    token = config.token
  const daemon = new JobDaemon({
    dbPath: config.dbPath,
    outputRoot: config.outputRoot,
    ...(config.tracking ? { tracking: config.tracking } : {}),
    ...(config.cliPreparation ? { cliPreparation: config.cliPreparation } : {}),
    ...(config.formalOci ? { formalOci: config.formalOci } : {}),
    ...(config.executionRuntimeMs ? { executionRuntimeMs: config.executionRuntimeMs } : {}),
    ...(config.renewalMs ? { renewalMs: config.renewalMs } : {}),
  })
  const workerArgv = config.workerArgv ? [...config.workerArgv] : undefined
  let pumping = false
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      daemon.reconcileInterrupted()
      daemon.enforceRuntimeLimits()
      for (const job of daemon.pendingJobs()) {
        if (job.status !== 'queued' || !daemon.hasAvailableSlot()) continue
        const worker = await daemon.launchWorker(
          job.spec.dispatchKey,
          workerArgv ? { workerArgv } : {},
        )
        await worker.exited
        daemon.reconcileInterrupted()
      }
    } finally {
      pumping = false
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    async fetch(request) {
      const authorization = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      if (
        authorization.length !== token.length ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(token))
      )
        return new Response('unauthorized', { status: 401 })
      const url = new URL(request.url)
      const authorityHeaders = () => ({
        'x-oph-authority-id': authorityId,
        'x-oph-authority-epoch': daemon.identity().epoch,
      })
      const respond = (job: DurableJob | null, status = 200) =>
        Response.json(
          { authorityId, job: projection(job) },
          { status, headers: authorityHeaders() },
        )
      if (request.method === 'GET' && url.pathname === '/identity')
        return Response.json(
          { authorityId, identity: daemon.identity() },
          { headers: authorityHeaders() },
        )
      if (request.method === 'GET' && url.pathname === '/health')
        return Response.json({
          authorityId,
          trackingPolicyHash: daemon.trackingPolicyHash ?? null,
          availableSlots: daemon.hasAvailableSlot() ? 1 : 0,
        })
      if (request.method === 'POST' && url.pathname === '/close-unstarted') {
        let body: unknown
        try {
          body = await boundedJson(request, 4096)
        } catch (error) {
          return new Response(
            error instanceof Error && error.message === 'too_large'
              ? 'too large'
              : 'invalid request',
            {
              status: error instanceof Error && error.message === 'too_large' ? 413 : 400,
              headers: authorityHeaders(),
            },
          )
        }
        if (!isClosureRequest(body))
          return new Response('invalid request', { status: 400, headers: authorityHeaders() })
        try {
          return Response.json(
            { authorityId, proof: daemon.closeUnstarted(body) },
            { headers: authorityHeaders() },
          )
        } catch {
          return Response.json(
            { authorityId, error: 'operation_rejected' },
            { status: 409, headers: authorityHeaders() },
          )
        }
      }
      if (request.method === 'POST' && url.pathname === '/submit') {
        let body: unknown
        try {
          body = await boundedJson(request, 65536)
        } catch (error) {
          return new Response(
            error instanceof Error && error.message === 'too_large'
              ? 'too large'
              : 'invalid request',
            {
              status: error instanceof Error && error.message === 'too_large' ? 413 : 400,
              headers: authorityHeaders(),
            },
          )
        }
        try {
          // The object envelope is mandatory for v3.  Legacy v1/v2 raw specs
          // remain readable by older clients and are accepted without a guard.
          const job = isSubmissionRequest(body)
            ? daemon.submit(body.spec, body.expectedEpoch)
            : daemon.submit(body)
          void pump().catch(() => {})
          return respond(job)
        } catch {
          return respond(null, 409)
        }
      }
      const match = /^\/(status|cancel|receipt)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(
        url.pathname,
      )
      if (!match) return new Response('not found', { status: 404 })
      const [, operation, key] = match
      daemon.reconcileInterrupted()
      if (request.method === 'GET' && operation === 'status') return respond(daemon.query(key!))
      if (request.method === 'POST' && operation === 'cancel') {
        let body: unknown
        try {
          body = request.body ? await boundedJson(request, 4096) : {}
        } catch {
          return new Response('invalid request', { status: 400, headers: authorityHeaders() })
        }
        const expectedEpoch = isRecordWithExpectedEpoch(body) ? body.expectedEpoch : undefined
        try {
          return respond(daemon.cancel(key!, expectedEpoch))
        } catch {
          return respond(null, 409)
        }
      }
      if (request.method === 'GET' && operation === 'receipt') {
        try {
          return new Response(daemon.receipt(key!), {
            headers: { 'content-type': 'application/json', ...authorityHeaders() },
          })
        } catch {
          return respond(null, 409)
        }
      }
      return new Response('method not allowed', { status: 405 })
    },
  })
  const timer = setInterval(() => {
    daemon.enforceRuntimeLimits()
    void pump().catch(() => {})
  }, 100)
  void pump().catch(() => {})
  return {
    port: server.port!,
    daemon,
    close() {
      clearInterval(timer)
      server.stop(true)
      daemon.close()
    },
  }
}

export async function runRemoteDaemonService(
  args: readonly string[],
  workerArgv: readonly string[],
) {
  if (args.length !== 2 || args[0] !== '--config') return 2
  const raw = await Bun.file(args[1]!).json()
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          'authorityId',
          'token',
          'port',
          'dbPath',
          'outputRoot',
          'tracking',
          'cliPreparation',
          'formalOci',
          'executionRuntimeMs',
          'renewalMs',
        ].includes(key),
    )
  )
    throw new Error('Invalid remote daemon administrator configuration')
  const service = createRemoteDaemonService({ ...raw, workerArgv })
  await new Promise<void>((resolve) => {
    const stop = () => {
      service.close()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
