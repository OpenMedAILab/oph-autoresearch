import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import type {
  ResearchAuthorityClosureProof,
  ResearchAuthorityClosureRequest,
  ResearchAuthorityIdentity,
} from '@oph-autoresearch/core'
import { isFormalOciJob } from './formal-job.ts'
import type { DurableJob, JobSpec } from './job-daemon.ts'

const MAX_RESPONSE_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 10_000
const SHA256 = /^sha256:[a-f0-9]{64}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/
const USER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const TEXT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface SshDaemonConfig {
  host: string
  user: string
  port: number
  identityFile: string
  knownHostsFile: string
  knownHostsHash: string
  remotePort: number
  token: string
  authorityId: string
  trackingPolicyHash?: string
}

export interface SshDaemonAuthority {
  readonly backendPolicyHash: string
  readonly trackingPolicyHash: string | undefined
  identity(): Promise<ResearchAuthorityIdentity>
  closeUnstarted(request: ResearchAuthorityClosureRequest): Promise<ResearchAuthorityClosureProof>
  submit(spec: JobSpec, expectedEpoch?: string): Promise<DurableJob>
  query(dispatchKey: string, expectedEpoch?: string): Promise<DurableJob | null>
  cancel(dispatchKey: string, expectedEpoch?: string): Promise<DurableJob | null>
  receipt(dispatchKey: string, expectedEpoch?: string): Promise<Uint8Array>
  reconcileInterrupted(): Promise<readonly DurableJob[]>
  hasAvailableSlot(): false
  launchWorker(): never
  close(): void
  availability(): Promise<0 | 1>
}

interface Tunnel {
  endpoint: string
  close(): void
}

type TestTunnelStarter = (config: Readonly<SshDaemonConfig>) => Promise<Tunnel>

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

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
function specBindingHash(spec: JobSpec): string | undefined {
  return isFormalOciJob(spec) ? spec.formalPlanHash : spec.inputHash
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function validEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
function validClosureRequest(value: unknown): value is ResearchAuthorityClosureRequest {
  return (
    isRecord(value) &&
    exactKeys(value, ['dispatchKey', 'expectedEpoch', 'specHash']) &&
    TEXT_ID.test(String(value.dispatchKey)) &&
    validEpoch(value.expectedEpoch) &&
    SHA256.test(String(value.specHash))
  )
}
function responseIdentity(value: unknown, authorityId: string): ResearchAuthorityIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['authorityId', 'identity']) ||
    value.authorityId !== authorityId ||
    !isRecord(value.identity) ||
    !exactKeys(value.identity, ['epoch', 'schema']) ||
    value.identity.schema !== 'research-authority-identity-v1' ||
    !validEpoch(value.identity.epoch)
  )
    throw new Error('SSH daemon authority identity does not match')
  return value.identity as unknown as ResearchAuthorityIdentity
}
function responseClosureProof(
  value: unknown,
  authorityId: string,
  request: ResearchAuthorityClosureRequest,
): ResearchAuthorityClosureProof {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['authorityId', 'proof']) ||
    value.authorityId !== authorityId ||
    !isRecord(value.proof) ||
    !exactKeys(value.proof, [
      'dispatchKey',
      'expectedEpoch',
      'outcome',
      'recordedAt',
      'schema',
      'specHash',
    ]) ||
    value.proof.schema !== 'research-authority-closure-v1' ||
    value.proof.dispatchKey !== request.dispatchKey ||
    value.proof.expectedEpoch !== request.expectedEpoch ||
    value.proof.specHash !== request.specHash ||
    ![
      'not_started',
      'cancel_requested',
      'completion_requested',
      'cancelled',
      'completed',
      'failed',
      'interrupted',
    ].includes(String(value.proof.outcome)) ||
    !Number.isSafeInteger(value.proof.recordedAt) ||
    (value.proof.recordedAt as number) < 0
  )
    throw new Error('SSH daemon closure proof does not match the request')
  return value.proof as unknown as ResearchAuthorityClosureProof
}

function safePort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function validConfig(config: SshDaemonConfig): boolean {
  return (
    HOST.test(config.host) &&
    USER.test(config.user) &&
    safePort(config.port) &&
    safePort(config.remotePort) &&
    TEXT_ID.test(config.authorityId) &&
    typeof config.token === 'string' &&
    /^[A-Za-z0-9_-]{16,512}$/.test(config.token) &&
    SHA256.test(config.knownHostsHash) &&
    (config.trackingPolicyHash === undefined || SHA256.test(config.trackingPolicyHash)) &&
    regularFile(config.identityFile) &&
    regularFile(config.knownHostsFile) &&
    !/["%\r\n\0]/.test(config.knownHostsFile) &&
    !/[%\r\n\0]/.test(config.identityFile) &&
    hashBytes(readFileSync(config.knownHostsFile)) === config.knownHostsHash
  )
}

function requestEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  )
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  if (!address || typeof address === 'string' || !safePort(address.port))
    throw new Error('SSH daemon tunnel could not reserve a loopback port')
  return address.port
}

async function startSshTunnel(config: Readonly<SshDaemonConfig>): Promise<Tunnel> {
  if (!validConfig(config)) throw new Error('SSH daemon startup files have changed')
  const localPort = await unusedLoopbackPort()
  let child: Bun.Subprocess
  try {
    child = Bun.spawn(
      [
        'ssh',
        '-F',
        'none',
        '-N',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${config.remotePort}`,
        '-p',
        String(config.port),
        '-i',
        config.identityFile,
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ForwardAgent=no',
        '-o',
        'RequestTTY=no',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile="${process.platform === 'win32' ? config.knownHostsFile.replaceAll('\\', '/') : config.knownHostsFile.replaceAll('\\', '\\\\')}"`,
        '-o',
        'GlobalKnownHostsFile=none',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'ProxyCommand=none',
        '-o',
        'PermitLocalCommand=no',
        `${config.user}@${config.host}`,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: requestEnvironment() },
    )
  } catch {
    throw new Error('SSH daemon tunnel could not start')
  }
  let ready = false
  const deadline = Date.now() + 6000
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: localPort })
      const finish = (ok: boolean) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(100, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
    if (!ready) await Bun.sleep(50)
  }
  if (!ready) {
    child.kill()
    await child.exited
    throw new Error('SSH daemon tunnel could not connect')
  }
  return {
    endpoint: `http://127.0.0.1:${localPort}`,
    close: () => child.kill(),
  }
}

function responseJob(value: unknown, expected: JobSpec | undefined): DurableJob | null {
  if (value === null) return null
  if (!isRecord(value) || !isRecord(value.spec) || typeof value.specHash !== 'string')
    throw new Error('SSH daemon returned an invalid job envelope')
  const job = value as unknown as DurableJob
  const receivedBinding = specBindingHash(job.spec)
  if (job.specHash !== hash(job.spec) || !receivedBinding || !SHA256.test(receivedBinding))
    throw new Error('SSH daemon returned an unbound job')
  if (
    expected &&
    (canonical(job.spec) !== canonical(expected) || receivedBinding !== specBindingHash(expected))
  )
    throw new Error('SSH daemon returned a job that does not match the submitted binding')
  return job
}

class Client implements SshDaemonAuthority {
  readonly backendPolicyHash: string
  readonly trackingPolicyHash: string | undefined
  private readonly bindings = new Map<string, { spec: JobSpec; epoch?: string }>()
  private tunnel: Tunnel | undefined
  private connecting: Promise<Tunnel> | undefined
  private closed = false

  constructor(
    private readonly config: Readonly<SshDaemonConfig>,
    private readonly startTunnel: TestTunnelStarter,
  ) {
    this.trackingPolicyHash = config.trackingPolicyHash
    this.backendPolicyHash = hash({
      authorityId: config.authorityId,
      host: config.host,
      identityFile: config.identityFile,
      knownHostsHash: config.knownHostsHash,
      port: config.port,
      remotePort: config.remotePort,
      trackingPolicyHash: config.trackingPolicyHash ?? null,
      user: config.user,
    })
  }

  private async endpoint(): Promise<string> {
    if (this.closed) throw new Error('SSH daemon authority is closed')
    if (this.tunnel) return this.tunnel.endpoint
    this.connecting ??= (async () => {
      const candidate = await this.startTunnel(this.config)
      try {
        await this.health(candidate.endpoint)
        if (this.closed) throw new Error('SSH daemon authority is closed')
        this.tunnel = candidate
        return candidate
      } catch {
        candidate.close()
        throw new Error('SSH daemon authority is unavailable')
      }
    })()
    try {
      return (await this.connecting).endpoint
    } catch {
      this.tunnel = undefined
      this.connecting = undefined
      throw new Error('SSH daemon authority is unavailable')
    }
  }

  private async bytes(
    endpoint: string,
    path: string,
    init: RequestInit = {},
    requireAuthorityHeader = false,
    expectedEpoch?: string,
  ): Promise<Uint8Array> {
    let response: Response
    try {
      response = await fetch(`${endpoint}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${this.config.token}`, ...init.headers },
      })
    } catch {
      this.tunnel?.close()
      this.tunnel = undefined
      this.connecting = undefined
      throw new Error('SSH daemon transport failed')
    }
    if (!response.ok) throw new Error('SSH daemon authority rejected the request')
    if (
      requireAuthorityHeader &&
      response.headers.get('x-oph-authority-id') !== this.config.authorityId
    )
      throw new Error('SSH daemon authority header does not match')
    if (
      expectedEpoch !== undefined &&
      response.headers.get('x-oph-authority-epoch') !== expectedEpoch
    )
      throw new Error('SSH daemon authority epoch does not match')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
      throw new Error('SSH daemon response exceeds the maximum size')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('SSH daemon response is empty')
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('SSH daemon response exceeds the maximum size')
        }
        chunks.push(part.value)
      }
    } catch {
      this.tunnel?.close()
      this.tunnel = undefined
      this.connecting = undefined
      throw new Error('SSH daemon response stream failed or exceeded the maximum size')
    }
    return Buffer.concat(chunks)
  }

  private async health(endpoint: string): Promise<0 | 1> {
    const body = await this.bytes(endpoint, '/health')
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error('SSH daemon health response is invalid')
    }
    if (
      !isRecord(value) ||
      value.authorityId !== this.config.authorityId ||
      value.trackingPolicyHash !== (this.trackingPolicyHash ?? null)
    )
      throw new Error('SSH daemon authority identity does not match')
    return value.availableSlots === 1 ? 1 : 0
  }

  private async envelope(
    path: string,
    init: RequestInit,
    expected?: JobSpec,
    expectedEpoch?: string,
  ): Promise<DurableJob | null> {
    const body = await this.bytes(await this.endpoint(), path, init, false, expectedEpoch)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error('SSH daemon returned invalid JSON')
    }
    if (!isRecord(value) || value.authorityId !== this.config.authorityId || !('job' in value))
      throw new Error('SSH daemon authority identity does not match')
    return responseJob(value.job, expected)
  }

  async identity(): Promise<ResearchAuthorityIdentity> {
    const body = await this.bytes(await this.endpoint(), '/identity', {}, true)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error('SSH daemon returned invalid JSON')
    }
    return responseIdentity(value, this.config.authorityId)
  }

  async closeUnstarted(
    request: ResearchAuthorityClosureRequest,
  ): Promise<ResearchAuthorityClosureProof> {
    if (!validClosureRequest(request)) throw new Error('invalid SSH daemon closure request')
    const body = await this.bytes(
      await this.endpoint(),
      '/close-unstarted',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      true,
    )
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error('SSH daemon returned invalid JSON')
    }
    return responseClosureProof(value, this.config.authorityId, request)
  }

  async submit(spec: JobSpec, expectedEpoch?: string): Promise<DurableJob> {
    if ((spec.version === 3 || isFormalOciJob(spec)) && !validEpoch(expectedEpoch))
      throw new Error('epoch-bound submission requires an authority epoch')
    const body =
      expectedEpoch === undefined ? JSON.stringify(spec) : JSON.stringify({ expectedEpoch, spec })
    const job = await this.envelope('/submit', { method: 'POST', body }, spec, expectedEpoch)
    if (!job || job.spec.dispatchKey !== spec.dispatchKey)
      throw new Error('SSH daemon did not confirm submission')
    this.bindings.set(
      spec.dispatchKey,
      expectedEpoch === undefined
        ? { spec: structuredClone(spec) }
        : { spec: structuredClone(spec), epoch: expectedEpoch },
    )
    return job
  }

  query(dispatchKey: string, expectedEpoch?: string): Promise<DurableJob | null> {
    if (!TEXT_ID.test(dispatchKey))
      return Promise.reject(new Error('invalid SSH daemon dispatch key'))
    const binding = this.bindings.get(dispatchKey)
    return this.envelope(
      `/status/${encodeURIComponent(dispatchKey)}`,
      {},
      binding?.spec,
      expectedEpoch ?? binding?.epoch,
    )
  }

  cancel(dispatchKey: string, expectedEpoch?: string): Promise<DurableJob | null> {
    if (!TEXT_ID.test(dispatchKey))
      return Promise.reject(new Error('invalid SSH daemon dispatch key'))
    const binding = this.bindings.get(dispatchKey)
    const epoch = expectedEpoch ?? binding?.epoch
    return this.envelope(
      `/cancel/${encodeURIComponent(dispatchKey)}`,
      { method: 'POST', body: JSON.stringify(epoch === undefined ? {} : { expectedEpoch: epoch }) },
      binding?.spec,
      epoch,
    )
  }

  async receipt(dispatchKey: string, expectedEpoch?: string): Promise<Uint8Array> {
    const binding = this.bindings.get(dispatchKey)
    const epoch = expectedEpoch ?? binding?.epoch
    const job = await this.query(dispatchKey, epoch)
    if (!job || job.status !== 'completed' || !job.contentHash)
      throw new Error('SSH daemon receipt is not available')
    const bytes = await this.bytes(
      await this.endpoint(),
      `/receipt/${encodeURIComponent(dispatchKey)}`,
      {},
      true,
      epoch,
    )
    if (hashBytes(bytes) !== job.contentHash)
      throw new Error('SSH daemon receipt does not match its job')
    return bytes
  }

  async reconcileInterrupted(): Promise<readonly DurableJob[]> {
    return []
  }
  async availability(): Promise<0 | 1> {
    return this.health(await this.endpoint())
  }

  hasAvailableSlot(): false {
    return false
  }

  launchWorker(): never {
    throw new Error('SSH daemon workers are managed by the remote authority')
  }

  close(): void {
    this.closed = true
    this.tunnel?.close()
    this.tunnel = undefined
  }
}

export function createSshDaemonClient(config: SshDaemonConfig): SshDaemonAuthority {
  if (!validConfig(config)) throw new Error('invalid SSH daemon configuration')
  return new Client(Object.freeze({ ...config }), startSshTunnel)
}

/** Test-only constructor. Production callers must use createSshDaemonClient. */
export function createSshDaemonClientForTest(
  config: SshDaemonConfig,
  startTunnel: TestTunnelStarter,
): SshDaemonAuthority {
  if (!validConfig(config)) throw new Error('invalid SSH daemon configuration')
  return new Client(Object.freeze({ ...config }), startTunnel)
}
