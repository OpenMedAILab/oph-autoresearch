import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { prepareCliDraft } from './cli-preparation.ts'
import { candidateReceipt } from './cli-preparation-candidate.ts'
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
import {
  captureRunnerTracking,
  collectRunnerTracking,
  verifyTrackingBinding,
} from './runner-tracking.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { fixedResearchTemplate } from './template-registry.ts'

type WorkerJob = {
  spec: DaemonJobSpec | FormalOciJobSpec
  status: string
  runtimeLease?: { ownerId: string; token: string; fence: number; expiresAt: number }
}

function formalOciConfig(): FormalOciAdministratorConfig | null {
  try {
    const value = JSON.parse(process.env.OPH_FORMAL_OCI_ADMIN_CONFIG ?? '') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as FormalOciAdministratorConfig)
      : null
  } catch {
    return null
  }
}

function cliPreparationConfig(): CliPreparationAdministratorConfig | null {
  try {
    const value = JSON.parse(process.env.OPH_CLI_PREPARATION_ADMIN_CONFIG ?? '') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const config = value as CliPreparationAdministratorConfig
    if (
      typeof config.workspaceRoot !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(config.backendPolicyHash) ||
      !config.workspaceRoot ||
      typeof config.workspaceScope !== 'string' ||
      typeof config.credentialHome !== 'string' ||
      !config.credentialHome ||
      !Array.isArray(config.adapters) ||
      config.adapters.length === 0 ||
      config.adapters.some(
        (adapter) =>
          !adapter ||
          typeof adapter !== 'object' ||
          !['codex-exec', 'claude-print'].includes(adapter.kind) ||
          typeof adapter.deviceId !== 'string' ||
          !adapter.deviceId ||
          typeof adapter.id !== 'string' ||
          !adapter.id ||
          typeof adapter.model !== 'string' ||
          !adapter.model ||
          typeof adapter.executable !== 'string' ||
          !adapter.executable ||
          /[\0\r\n]/.test(adapter.executable) ||
          !/^sha256:[a-f0-9]{64}$/.test(adapter.binaryHash),
      )
    )
      return null
    return config
  } catch {
    return null
  }
}

function hashBytes(value: Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
function safeOutputDirectory(root: string, dispatchKey: string) {
  const absoluteRoot = resolve(root)
  const rootStat = lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe output root')
  const realRoot = realpathSync(absoluteRoot)
  const directory = resolve(absoluteRoot, dispatchKey)
  if (directory !== join(absoluteRoot, dispatchKey)) throw new Error('output escapes root')
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe output directory')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    mkdirSync(directory)
  }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe output directory')
  const realDirectory = realpathSync(directory)
  if (!realDirectory.startsWith(`${realRoot}${sep}`)) throw new Error('output escapes root')
  return directory
}

export async function runResearchJobWorker(args: readonly string[]) {
  const [endpoint, dispatchKey, root, token] = args
  if (!endpoint || !dispatchKey || !root || !token) return 2
  const headers = { authorization: `Bearer ${token}` }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${endpoint}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
      headers: { ...headers, ...init.headers },
    })
  const initial = await request(`/jobs/${encodeURIComponent(dispatchKey)}`)
  const job = (initial.ok ? await initial.json() : null) as WorkerJob | null
  if (!job || job.spec.dispatchKey !== dispatchKey || job.status !== 'queued') return 3
  const claimed = await request(`/claim/${encodeURIComponent(dispatchKey)}`, {
    method: 'POST',
    body: JSON.stringify({ lease: job.spec.lease, workerPid: process.pid }),
  })
  if (!claimed.ok) return 4
  const claimedJob = (await claimed.json()) as WorkerJob
  let runtimeLease = claimedJob.runtimeLease ?? job.spec.lease
  let terminationRequested = false
  // Keep this leader alive after daemon SIGTERM. The daemon's owned process-group
  // escalation can then reach a nested CLI that deliberately ignores TERM.
  const onTermination = () => {
    terminationRequested = true
  }
  if (job.spec.version === 3 || isFormalOciJob(job.spec)) process.on('SIGTERM', onTermination)
  let stopped = false
  let heartbeatInFlight = Promise.resolve()
  // Heartbeats only change authority runtime state. The JobSpec and its hash stay immutable.
  const renew = () => {
    if (stopped) return
    heartbeatInFlight = heartbeatInFlight
      .then(async () => {
        const response = await request(`/renew/${encodeURIComponent(dispatchKey)}`, {
          method: 'POST',
          body: JSON.stringify({ lease: runtimeLease }),
        })
        if (!response.ok) return
        const renewed = (await response.json()) as WorkerJob
        if (renewed.runtimeLease) runtimeLease = renewed.runtimeLease
      })
      .catch(() => {})
  }
  const heartbeat = setInterval(() => {
    renew()
  }, 1_000)
  const done = async () => {
    stopped = true
    clearInterval(heartbeat)
    await heartbeatInFlight
  }
  // The only safe exit after daemon TERM is its owned group SIGKILL. Returning
  // would lose the group leader and could strand a TERM-ignoring CLI descendant.
  const awaitCancellationEscalation = async () => {
    if (!terminationRequested) return
    await new Promise<never>(() => {})
  }
  try {
    if (process.env.JOB_DAEMON_WORKER_WAIT_AFTER_CLAIM === '1') await Bun.sleep(60_000)
    const latest = (await request(`/jobs/${encodeURIComponent(dispatchKey)}`).then((response) =>
      response.ok ? response.json() : null,
    )) as WorkerJob | null
    if (!latest || latest.status !== 'running') {
      if (latest?.status === 'cancel_requested')
        await request(`/cancelled/${encodeURIComponent(dispatchKey)}`, {
          method: 'POST',
          body: JSON.stringify({ lease: runtimeLease }),
        })
      return 0
    }
    if (isFormalOciJob(job.spec)) {
      const config = formalOciConfig()
      if (!config) return 10
      const directory = safeOutputDirectory(root, dispatchKey)
      let adapter: FormalOciAdapter
      try {
        adapter = new FormalOciAdapter(config)
        const result = adapter.run(job.spec, directory)
        if (result.exitCode !== 0 || terminationRequested) return 11
        const receipt = Buffer.from(`${JSON.stringify(adapter.evaluate(job.spec, directory))}\n`)
        const path = join(directory, 'formal-receipt.json')
        await writeFile(path, receipt, { flag: 'wx' })
        await heartbeatInFlight
        const finish = await request(`/finish/${encodeURIComponent(dispatchKey)}`, {
          method: 'POST',
          body: JSON.stringify({
            lease: runtimeLease,
            result: { contentHash: hashBytes(receipt), outputPath: path },
          }),
        })
        return finish.ok ? 0 : 6
      } catch {
        return 12
      }
    }
    if (isCliPreparationJob(job.spec)) {
      const cliJob = job.spec as CliPreparationJobSpec
      const config = cliPreparationConfig()
      const adapter = config?.adapters.find(
        (candidate) =>
          candidate.deviceId === cliJob.execution.deviceId &&
          candidate.id === cliJob.execution.adapterId &&
          candidate.model === cliJob.execution.model,
      )
      if (
        !config ||
        !adapter ||
        config.backendPolicyHash !== cliJob.backendPolicyHash ||
        cliPreparationExecutableHash(adapter.executable) !== adapter.binaryHash ||
        cliJob.execution.adapterConfigHash !== cliPreparationAdapterConfigHash(adapter)
      )
        return 8
      const approvedConfig = {
        kind: adapter.kind,
        id: adapter.id,
        model: adapter.model,
        executable: adapter.executable,
        binaryHash: adapter.binaryHash,
      }
      const capabilityHash = sha256(
        canonicalJson({
          taskRevisionId: cliJob.taskRevisionId,
          workspaceScope: config.workspaceScope,
          instructions: cliJob.execution.instructions,
          maxRuntimeMs: cliJob.execution.maxRuntimeMs,
          config: approvedConfig,
        }),
      )
      let draft: Awaited<ReturnType<typeof prepareCliDraft>>
      try {
        draft = await prepareCliDraft({
          workspaceRoot: config.workspaceRoot,
          workspaceScope: config.workspaceScope,
          instructions: cliJob.execution.instructions,
          maxRuntimeMs: cliJob.execution.maxRuntimeMs,
          adapter: approvedConfig,
          credentialHome: config.credentialHome,
          processGroup: 'daemon-worker',
          capability: {
            taskRevisionId: cliJob.taskRevisionId,
            specHash: capabilityHash,
            verify: () => true,
          },
        })
      } catch {
        await awaitCancellationEscalation()
        return 9
      }
      await awaitCancellationEscalation()
      const bytes = Buffer.from(`${JSON.stringify(candidateReceipt(cliJob, draft))}\n`)
      const directory = safeOutputDirectory(root, dispatchKey)
      const path = join(directory, 'candidate.json')
      await writeFile(path, bytes, { flag: 'wx' })
      if (terminationRequested) {
        await unlink(path).catch(() => {})
        await awaitCancellationEscalation()
      }
      await awaitCancellationEscalation()
      await heartbeatInFlight
      const finish = await request(`/finish/${encodeURIComponent(dispatchKey)}`, {
        method: 'POST',
        body: JSON.stringify({
          lease: runtimeLease,
          result: { contentHash: hashBytes(bytes), outputPath: path },
        }),
      })
      if (!finish.ok) return 6
      // The authority has durably accepted this receipt and begins reaping the
      // whole job group before marking it completed. Do not race its SIGTERM
      // delivery: exiting first would strand a stream-closed descendant because
      // the authority can no longer prove ownership of this group leader.
      return await new Promise<never>(() => {})
    }
    const plan = fixedResearchTemplate(job.spec.templateId)
    await plan.assertSkill()
    const payload = plan.execute()
    if (payload.inputHash !== job.spec.inputHash) return 5
    const trackingConfig =
      process.env.OPH_RESEARCH_TRACKING_STDIN === '1'
        ? captureRunnerTracking(JSON.parse(await Bun.stdin.text()))
        : undefined
    if (job.spec.trackingPolicyHash !== trackingConfig?.policyHash) return 7
    const tracking = trackingConfig
      ? await collectRunnerTracking(trackingConfig.config, {
          dispatchKey,
          policyHash: trackingConfig.policyHash,
          payload,
        })
      : undefined
    const directory = safeOutputDirectory(root, dispatchKey)
    const path = join(directory, plan.filename)
    const bytes = Buffer.from(
      `${JSON.stringify({ ...payload, ...(tracking ? { tracking } : {}) })}\n`,
    )
    verifyTrackingBinding(bytes, job.spec)
    plan.verify(bytes)
    await writeFile(path, bytes, { flag: 'wx' })
    // Serialize the last renewal before finalizing so a late heartbeat cannot race finish.
    await heartbeatInFlight
    const finish = await request(`/finish/${encodeURIComponent(dispatchKey)}`, {
      method: 'POST',
      body: JSON.stringify({
        lease: runtimeLease,
        result: { contentHash: hashBytes(bytes), outputPath: path },
      }),
    })
    return finish.ok ? 0 : 6
  } finally {
    if (job.spec.version === 3 || isFormalOciJob(job.spec)) await awaitCancellationEscalation()
    await done()
    if (job.spec.version === 3 || isFormalOciJob(job.spec)) process.off('SIGTERM', onTermination)
  }
}

if (import.meta.main) process.exit(await runResearchJobWorker(Bun.argv.slice(2)))
