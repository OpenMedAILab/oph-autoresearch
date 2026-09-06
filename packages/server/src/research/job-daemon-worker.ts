import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  captureRunnerTracking,
  collectRunnerTracking,
  verifyTrackingBinding,
} from './runner-tracking.ts'
import { fixedResearchTemplate } from './template-registry.ts'

type WorkerJob = {
  spec: {
    dispatchKey: string
    inputHash: string
    lease: unknown
    templateId: unknown
    trackingPolicyHash?: string
  }
  status: string
  runtimeLease?: { ownerId: string; token: string; fence: number; expiresAt: number }
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
  const plan = fixedResearchTemplate(job.spec.templateId)
  const claimed = await request(`/claim/${encodeURIComponent(dispatchKey)}`, {
    method: 'POST',
    body: JSON.stringify({ lease: job.spec.lease, workerPid: process.pid }),
  })
  if (!claimed.ok) return 4
  const claimedJob = (await claimed.json()) as WorkerJob
  let runtimeLease = claimedJob.runtimeLease ?? job.spec.lease
  let stopped = false
  let heartbeatInFlight = Promise.resolve()
  // Heartbeats only change authority runtime state. The JobSpec and its hash stay immutable.
  const renew = () => {
    if (stopped) return
    heartbeatInFlight = heartbeatInFlight
      .then(async () => {
        const response = await request(`/renew/${encodeURIComponent(dispatchKey)}`, {
          method: 'POST', body: JSON.stringify({ lease: runtimeLease }),
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
    await done()
  }
}

if (import.meta.main) process.exit(await runResearchJobWorker(Bun.argv.slice(2)))
