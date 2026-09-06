import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
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

  test('localhost authority expires queued work without an observer or remote service pump', async () => {
    const { daemon } = await fresh()
    daemon.submit(spec('local-watchdog', 1, 'synthetic-summary-v1', Date.now() + 20))
    await waitFor(daemon, 'local-watchdog', 'cancelled')
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

  test('a restarted daemon cancels the original verified worker group and persists its exit', async () => {
    const { root, daemon } = await fresh()
    const key = 'live-cancel-ack'
    daemon.submit(spec(key))
    const worker = await daemon.launchWorker(key, { waitAfterClaim: true })
    let observer: JobDaemon | undefined
    try {
      await waitFor(daemon, key, 'running')
      // A fresh handle has no in-memory child to kill, as after an authority restart.
      observer = new JobDaemon({
        dbPath: join(root, 'jobs.sqlite'),
        outputRoot: join(root, 'out'),
      })
      observer.startHttp()
      expect(observer.cancel(key)).toMatchObject({ status: 'cancel_requested' })
      await worker.exited
      await waitFor(observer, key, 'cancelled')
      expect(observer.query(key)).toMatchObject({ status: 'cancelled' })
      expect(daemon.query(key)).toMatchObject({ status: 'cancelled' })
    } finally {
      if (
        (await Promise.race([worker.exited.then(() => true), Bun.sleep(1).then(() => false)])) ===
        false
      )
        worker.kill()
      observer?.close()
      daemon.close()
    }
  })

  test('a restarted daemon never signals a live PID whose start identity no longer matches', async () => {
    const { root, daemon } = await fresh()
    const key = 'reused-pid'
    daemon.submit(spec(key))
    const worker = await daemon.launchWorker(key, { waitAfterClaim: true })
    let observer: JobDaemon | undefined
    try {
      await waitFor(daemon, key, 'running')
      observer = new JobDaemon({
        dbPath: join(root, 'jobs.sqlite'),
        outputRoot: join(root, 'out'),
        processProbe: { startIdentity: (pid) => `different-process:${pid}` },
      })
      expect(observer.cancel(key)).toMatchObject({ status: 'cancel_requested' })
      // Give the TERM and KILL windows time to run. The worker is one this test
      // launched, and a PID-reuse observation must leave it alone.
      expect(
        await Promise.race([worker.exited.then(() => false), Bun.sleep(350).then(() => true)]),
      ).toBe(true)
      expect(observer.query(key)).toMatchObject({ status: 'cancel_requested' })
    } finally {
      worker.kill()
      await worker.exited
      observer?.close()
      daemon.close()
    }
  })

  if (process.platform !== 'win32') {
    test('escalates a verified stubborn worker group from TERM to KILL after the grace period', async () => {
      const { daemon } = await fresh()
      const key = 'stubborn-group'
      daemon.submit(spec(key))
      const stubbornWorker = `
        import { mkdirSync, writeFileSync } from 'node:fs'
        import { join } from 'node:path'
        const [endpoint, dispatchKey, root, token] = process.argv.slice(1)
        const headers = { authorization: 'Bearer ' + token }
        const job = await fetch(endpoint + '/jobs/' + encodeURIComponent(dispatchKey), { headers }).then((r) => r.json())
        process.on('SIGTERM', () => {})
        const descendant = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdout: 'ignore', stderr: 'ignore' })
        mkdirSync(join(root, dispatchKey), { recursive: true })
        writeFileSync(join(root, dispatchKey, 'stubborn-child.pid'), String(descendant.pid))
        const claimed = await fetch(endpoint + '/claim/' + encodeURIComponent(dispatchKey), {
          method: 'POST', headers, body: JSON.stringify({ lease: job.spec.lease, workerPid: process.pid }),
        })
        if (!claimed.ok) process.exit(4)
        setInterval(() => {}, 1000)
      `
      const worker = await daemon.launchWorker(key, {
        workerArgv: [process.execPath, '-e', stubbornWorker],
      })
      await waitFor(daemon, key, 'running')
      const descendantPid = Number(
        await readFile(join(daemon.outputRoot, key, 'stubborn-child.pid'), 'utf8'),
      )
      expect(descendantPid).toBeGreaterThan(0)
      expect(daemon.cancel(key)).toMatchObject({ status: 'cancel_requested' })
      await worker.exited
      await waitFor(daemon, key, 'cancelled')
      expect(() => process.kill(descendantPid, 0)).toThrow()
      daemon.close()
    })

    test('leaves a descendant-only group pending when its recorded leader has exited', async () => {
      const { daemon } = await fresh()
      const key = 'orphaned-group'
      daemon.submit(spec(key))
      const orphaningWorker = `
        import { mkdirSync, writeFileSync } from 'node:fs'
        import { join } from 'node:path'
        const [endpoint, dispatchKey, root, token] = process.argv.slice(1)
        const headers = { authorization: 'Bearer ' + token }
        const job = await fetch(endpoint + '/jobs/' + encodeURIComponent(dispatchKey), { headers }).then((r) => r.json())
        const descendant = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdout: 'ignore', stderr: 'ignore' })
        mkdirSync(join(root, dispatchKey), { recursive: true })
        writeFileSync(join(root, dispatchKey, 'orphaned-child.pid'), String(descendant.pid))
        const claimed = await fetch(endpoint + '/claim/' + encodeURIComponent(dispatchKey), {
          method: 'POST', headers, body: JSON.stringify({ lease: job.spec.lease, workerPid: process.pid }),
        })
        process.exit(claimed.ok ? 0 : 4)
      `
      const worker = await daemon.launchWorker(key, {
        workerArgv: [process.execPath, '-e', orphaningWorker],
      })
      await worker.exited
      await waitFor(daemon, key, 'running')
      const descendantPid = Number(
        await readFile(join(daemon.outputRoot, key, 'orphaned-child.pid'), 'utf8'),
      )
      try {
        expect(daemon.cancel(key)).toMatchObject({ status: 'cancel_requested' })
        await Bun.sleep(350)
        expect(daemon.query(key)).toMatchObject({ status: 'cancel_requested' })
      } finally {
        // This test created and recorded this exact descendant; clean it up
        // directly without asking the daemon to infer an unprovable PGID owner.
        process.kill(descendantPid, 'SIGKILL')
        await Bun.sleep(20)
        daemon.reconcileInterrupted()
        daemon.close()
      }
    })
  }

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
    // POSIX has no junctions; a directory symlink exercises the same lstat/realpath boundary.
    // Windows uses a junction because its directory symlink privilege is often unavailable.
    if (process.platform === 'win32') {
      await Bun.spawn(['cmd', '/c', 'mkdir', outside]).exited
      await symlink(outside, join(root, 'out', 'junction'), 'junction')
    } else {
      await Bun.write(outside, '')
      await rm(outside)
      await Bun.spawn(['mkdir', outside]).exited
      await symlink(outside, join(root, 'out', 'junction'), 'dir')
    }
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

  test('renews mutable runtime lease without changing the durable v1 spec hash, then enforces its separate deadline', async () => {
    const { daemon } = await fresh()
    const submitted = daemon.submit(spec('renewable', 1, 'synthetic-summary-v1', Date.now() + 30))
    const { endpoint, token } = daemon.startHttp()
    const claimed = await fetch(`${endpoint}/claim/renewable`, {
      method: 'POST',
      headers: authenticated(token),
      body: JSON.stringify({ lease: submitted.spec.lease, workerPid: 999_999 }),
    })
    expect(claimed.ok).toBe(true)
    const runtime = ((await claimed.json()) as JobSpec & { runtimeLease?: JobSpec['lease'] })
      .runtimeLease
    expect(runtime).toBeDefined()
    const renewed = await fetch(`${endpoint}/renew/renewable`, {
      method: 'POST',
      headers: authenticated(token),
      body: JSON.stringify({ lease: runtime }),
    })
    expect(renewed.ok).toBe(true)
    // Simulate a dropped renewal response: the worker retries its prior generation.
    const replay = await fetch(`${endpoint}/renew/renewable`, {
      method: 'POST',
      headers: authenticated(token),
      body: JSON.stringify({ lease: runtime }),
    })
    expect(replay.ok).toBe(true)
    const observed = daemon.query('renewable')!
    expect(observed.specHash).toBe(submitted.specHash)
    expect(observed.spec).toEqual(submitted.spec)
    expect(observed.runtimeLease?.fence).toBe(2)
    daemon.close()
  })

  test('global runtime configuration can constrain v1 but cannot enlarge its frozen approved expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oph-job-daemon-'))
    roots.push(root)
    const daemon = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'out'),
      executionRuntimeMs: 90,
      renewalMs: 40,
    })
    const submitted = daemon.submit(spec('deadline', 1, 'synthetic-summary-v1', Date.now() + 20))
    const { endpoint, token } = daemon.startHttp()
    const claim = await fetch(`${endpoint}/claim/deadline`, {
      method: 'POST',
      headers: authenticated(token),
      body: JSON.stringify({ lease: submitted.spec.lease, workerPid: 999_998 }),
    })
    const initial = (await claim.json()) as {
      runtimeLease: JobSpec['lease']
      executionDeadlineAt: number
    }
    const deadline = initial.executionDeadlineAt
    expect(deadline).toBeLessThanOrEqual(submitted.spec.lease.expiresAt)
    await Bun.sleep(Math.max(1, deadline - Date.now() + 5))
    daemon.enforceRuntimeLimits()
    daemon.reconcileInterrupted()
    // The worker PID was synthetic, so no durable start identity was captured.
    // Deadline cancellation is recorded but cannot be terminalized by guessing.
    expect(daemon.query('deadline')?.status).toBe('cancel_requested')
    daemon.close()
  })
})
