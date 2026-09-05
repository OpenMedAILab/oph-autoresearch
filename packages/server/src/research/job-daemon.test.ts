import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobDaemon, type JobSpec, type JobTemplate } from './job-daemon.ts'
import { fixedResearchTemplate } from './template-registry.ts'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'oph-job-daemon-'))
  roots.push(root)
  return {
    root,
    daemon: new JobDaemon({ dbPath: join(root, 'jobs.sqlite'), outputRoot: join(root, 'out') }),
  }
}
function spec(
  key = 'dispatch-1',
  fence = 1,
  templateId: JobTemplate = 'synthetic-summary-v1',
  expiresAt = Date.now() + 60_000,
): JobSpec {
  return {
    version: 1,
    dispatchKey: key,
    campaignId: 'campaign-1',
    taskRevisionId: 'task-1',
    templateId,
    inputHash: fixedResearchTemplate(templateId).execute().inputHash,
    resource: { cpu: 1, memoryMb: 128 },
    lease: { ownerId: 'daemon', token: 'lease-1', fence, expiresAt },
  }
}
async function waitFor(daemon: JobDaemon, key: string, status: string) {
  for (let i = 0; i < 150; i++) {
    if (daemon.query(key)?.status === status) return
    await Bun.sleep(10)
  }
  throw new Error(`job did not reach ${status}`)
}
function authenticated(token: string) {
  return { authorization: `Bearer ${token}` }
}

describe('durable localhost job daemon', () => {
  test('uses an exact fixed plan hash and atomically handles replay across database handles', async () => {
    const { root, daemon } = await fresh()
    const submittedSpec = spec()
    const first = daemon.submit(submittedSpec)
    const second = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'out'),
    })
    expect(second.submit(submittedSpec)).toEqual(first)
    expect(() =>
      second.submit({ ...submittedSpec, lease: { ...submittedSpec.lease, fence: 2 } }),
    ).toThrow('dispatch_key_conflict')
    expect(() =>
      daemon.submit({ ...spec('wrong-hash'), inputHash: `sha256:${'a'.repeat(64)}` }),
    ).toThrow('fixed_template_input_hash_mismatch')
    expect(daemon.query('unknown')).toBeNull()
    second.close()
    daemon.close()
  })

  test('requires a random loopback bearer token and refuses expired or stale leases', async () => {
    const { daemon } = await fresh()
    const expired = daemon.submit(spec('expired', 1, 'synthetic-summary-v1', Date.now() - 1))
    const { endpoint, token } = daemon.startHttp()
    expect((await fetch(`${endpoint}/jobs/expired`)).status).toBe(401)
    expect(
      (
        await fetch(`${endpoint}/claim/expired`, {
          method: 'POST',
          headers: authenticated(token),
          body: JSON.stringify({ lease: expired.spec.lease }),
        })
      ).status,
    ).toBe(409)
    const valid = daemon.submit(spec('fenced'))
    expect(
      (
        await fetch(`${endpoint}/claim/fenced`, {
          method: 'POST',
          headers: authenticated(token),
          body: JSON.stringify({ lease: valid.spec.lease, workerPid: process.pid }),
        })
      ).ok,
    ).toBe(true)
    const stale = { ...valid.spec.lease, fence: 2 }
    expect(
      (
        await fetch(`${endpoint}/finish/fenced`, {
          method: 'POST',
          headers: authenticated(token),
          body: JSON.stringify({
            lease: stale,
            result: { contentHash: `sha256:${'b'.repeat(64)}`, outputPath: join('bad') },
          }),
        })
      ).status,
    ).toBe(409)
    daemon.close()
  })

  test('runs the fixed registry plans in real workers and verifies their contract bytes', async () => {
    const { daemon } = await fresh()
    daemon.submit(spec('summary-completes'))
    const summary = await daemon.launchWorker('summary-completes')
    await summary.exited
    await waitFor(daemon, 'summary-completes', 'completed')
    expect(daemon.query('summary-completes')?.outputPath).toEndWith('summary.json')
    daemon.submit(spec('training-completes', 1, 'synthetic-training-evaluation-v1'))
    const training = await daemon.launchWorker('training-completes')
    await training.exited
    await waitFor(daemon, 'training-completes', 'completed')
    expect(daemon.query('training-completes')?.outputPath).toEndWith('training-evaluation.json')
    daemon.close()
  })

  test('cancellation remains requested until worker exit acknowledges it, then persists', async () => {
    const { root, daemon } = await fresh()
    daemon.submit(spec('cancelled'))
    const worker = await daemon.launchWorker('cancelled', { waitAfterClaim: true })
    await waitFor(daemon, 'cancelled', 'running')
    expect(daemon.cancel('cancelled')).toMatchObject({ status: 'cancel_requested' })
    await worker.exited
    await waitFor(daemon, 'cancelled', 'cancelled')
    daemon.close()
    const restarted = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'out'),
    })
    expect(restarted.query('cancelled')).toMatchObject({ status: 'cancelled' })
    restarted.close()
  })

  test('a cancellation acknowledgement cannot terminalize a job while its recorded worker PID is live', async () => {
    const { root, daemon } = await fresh()
    const key = 'live-cancel-ack'
    const submitted = daemon.submit(spec(key))
    const worker = await daemon.launchWorker(key, { waitAfterClaim: true })
    let observer: JobDaemon | undefined
    try {
      await waitFor(daemon, key, 'running')
      // A fresh handle has no in-memory child to kill, as after an authority restart.
      observer = new JobDaemon({
        dbPath: join(root, 'jobs.sqlite'),
        outputRoot: join(root, 'out'),
      })
      const { endpoint, token } = observer.startHttp()
      expect(observer.cancel(key)).toMatchObject({ status: 'cancel_requested' })
      const acknowledged = await fetch(`${endpoint}/cancelled/${key}`, {
        method: 'POST',
        headers: authenticated(token),
        body: JSON.stringify({ lease: submitted.spec.lease }),
      })
      expect(acknowledged.status).toBe(200)
      expect(observer.query(key)).toMatchObject({ status: 'cancel_requested' })
      expect(daemon.query(key)).toMatchObject({ status: 'cancel_requested' })
    } finally {
      worker.kill()
      await worker.exited
      observer?.close()
      daemon.close()
    }
  })

  test('reconciliation leaves a live worker running because its exit cannot be confirmed', async () => {
    const { daemon } = await fresh()
    const key = 'live-worker-observation'
    const submitted = daemon.submit(spec(key))
    const { endpoint, token } = daemon.startHttp()
    const claimed = await fetch(`${endpoint}/claim/${key}`, {
      method: 'POST',
      headers: authenticated(token),
      body: JSON.stringify({ lease: submitted.spec.lease, workerPid: process.pid }),
    })
    expect(claimed.ok).toBe(true)
    expect(daemon.reconcileInterrupted()).toEqual([])
    expect(daemon.query(key)).toMatchObject({ status: 'running' })
    daemon.close()
  })

  test('rejects junction output paths and marks killed unacknowledged workers interrupted only after restart reconciliation', async () => {
    const { root, daemon } = await fresh()
    daemon.submit(spec('junction'))
    const outside = join(root, 'outside')
    await Bun.write(outside, '')
    await rm(outside)
    await Bun.spawn(['cmd', '/c', 'mkdir', outside]).exited
    await symlink(outside, join(root, 'out', 'junction'), 'junction')
    const unsafe = await daemon.launchWorker('junction')
    expect(await unsafe.exited).not.toBe(0)
    expect(daemon.query('junction')).toMatchObject({ status: 'running' })
    expect(daemon.reconcileInterrupted()).toMatchObject([{ status: 'interrupted' }])

    daemon.submit(spec('killed-worker'))
    const child = await daemon.launchWorker('killed-worker', { waitAfterClaim: true })
    await waitFor(daemon, 'killed-worker', 'running')
    child.kill()
    await child.exited
    daemon.close()
    const restarted = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'out'),
    })
    expect(restarted.reconcileInterrupted()).toMatchObject([
      { spec: { dispatchKey: 'junction' }, status: 'interrupted' },
      { spec: { dispatchKey: 'killed-worker' }, status: 'interrupted' },
    ])
    expect(() => restarted.submit(spec('killed-worker'))).toThrow('dispatch_key_conflict')
    restarted.close()
  })
})
