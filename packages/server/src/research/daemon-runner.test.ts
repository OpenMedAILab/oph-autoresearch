import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { JobDaemon } from './job-daemon.ts'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { cancelSyntheticRun, reconcileSyntheticRun, startSyntheticRun } from './synthetic-runner.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fresh() {
  const root = await mkdtemp(
    join(resolve(import.meta.dir, '../../../..'), '.tmp', 'evaluation-runner-'),
  )
  roots.push(root)
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, root, 'evaluation-runner')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'evaluation-campaign',
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'run fixed synthetic evaluation',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!created.ok) throw new Error(created.message)
  return {
    store,
    root,
    workspace,
    parent,
    campaign: created.campaign,
    protocol: syntheticProtocol(store, root, created.campaign.id),
  }
}

function anotherCampaign(
  store: Store,
  workspaceId: string,
  parentConversationId: string,
  key: string,
) {
  const created = createResearchCampaign(store, {
    idempotencyKey: key,
    workspaceId,
    parentConversationId,
    goal: `run ${key}`,
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!created.ok) throw new Error(created.message)
  return created.campaign
}

describe('durable daemon runner integration', () => {
  test('one ledger attempt dispatches a real worker and emits a verified local receipt', async () => {
    const { store, root, campaign, protocol } = await fresh()
    const daemon = new JobDaemon({
      dbPath: join(root, 'daemon.sqlite'),
      outputRoot: join(root, 'daemon-output'),
    })
    try {
      const input = {
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'daemon-once',
        templateId: 'synthetic-training-evaluation-v1' as const,
        daemonBackend: { daemon },
      }
      const result = await startSyntheticRun(input)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      expect(result.campaign.attempts[0]).toMatchObject({
        backend: 'localhost-daemon',
        status: 'completed',
        jobSpec: { resource: { cpu: 1, memoryMb: 256 } },
      })
      expect(daemon.query(result.attemptId)?.status).toBe('completed')
      expect((await protocol.receipt(result.attemptId)).reviewKind).toBe(
        'fixed-contract-recomputation',
      )
      expect(await startSyntheticRun(input)).toMatchObject({
        ok: true,
        replayed: true,
        attemptId: result.attemptId,
      })
    } finally {
      daemon.close()
      store.close()
    }
  })
  test('lost submit acknowledgement remains unknown without redispatch, then explicit observation completes same attempt', async () => {
    const { store, root, campaign } = await fresh()
    const daemon = new JobDaemon({
      dbPath: join(root, 'daemon.sqlite'),
      outputRoot: join(root, 'daemon-output'),
    })
    try {
      const submit = daemon.submit.bind(daemon)
      daemon.submit = (value) => {
        submit(value)
        throw new Error('simulated lost acknowledgement')
      }
      const result = await startSyntheticRun({
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'lost-ack',
        daemonBackend: { daemon },
      })
      expect(result).toMatchObject({ ok: false, code: 'execution_unknown' })
      const attempt = getResearchCampaign(store, campaign.id)!.attempts[0]!
      const observation = {
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: getResearchCampaign(store, campaign.id)!.version,
        attemptId: attempt.id,
        daemonBackend: { daemon },
      }
      expect(await reconcileSyntheticRun(observation)).toMatchObject({
        ok: false,
        code: 'execution_unknown',
      })
      expect(daemon.query(attempt.id)?.status).toBe('queued')
      const child = await daemon.launchWorker(attempt.id)
      await child.exited
      const reconciled = await reconcileSyntheticRun(observation)
      expect(reconciled).toMatchObject({ ok: true, attemptId: attempt.id })
      expect(getResearchCampaign(store, campaign.id)!.attempts).toHaveLength(1)
    } finally {
      daemon.close()
      store.close()
    }
  })
  test('cancel waits for the real worker exit before the ledger becomes cancelled', async () => {
    const { store, root, campaign } = await fresh()
    const daemon = new JobDaemon({
      dbPath: join(root, 'daemon.sqlite'),
      outputRoot: join(root, 'daemon-output'),
    })
    try {
      const launch = daemon.launchWorker.bind(daemon)
      daemon.launchWorker = (key) => launch(key, { waitAfterClaim: true })
      const pending = startSyntheticRun({
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'cancel-worker',
        daemonBackend: { daemon },
      })
      let attemptId = ''
      for (let i = 0; i < 200; i++) {
        attemptId = getResearchCampaign(store, campaign.id)!.attempts[0]?.id ?? ''
        if (daemon.query(attemptId)?.status === 'running') break
        await Bun.sleep(10)
      }
      expect(daemon.query(attemptId)?.status).toBe('running')
      const cancelled = cancelSyntheticRun({
        store,
        campaignId: campaign.id,
        expectedVersion: getResearchCampaign(store, campaign.id)!.version,
        attemptId,
        daemonBackend: { daemon },
      })
      expect(cancelled.ok).toBe(true)
      await pending
      expect(daemon.query(attemptId)?.status).toBe('cancelled')
      expect(getResearchCampaign(store, campaign.id)!.attempts[0]?.status).toBe('cancelled')
    } finally {
      daemon.close()
      store.close()
    }
  })

  test('holds queued work without repeatedly spawning a worker while the single daemon slot is occupied', async () => {
    const { store, root, workspace, parent, campaign } = await fresh()
    const queuedCampaign = anotherCampaign(store, workspace.id, parent.id, 'queued-campaign')
    const daemon = new JobDaemon({
      dbPath: join(root, 'daemon.sqlite'),
      outputRoot: join(root, 'daemon-output'),
    })
    try {
      const launch = daemon.launchWorker.bind(daemon)
      const launches: string[] = []
      let heldKey = ''
      daemon.launchWorker = (key, options) => {
        launches.push(key)
        heldKey ||= key
        return launch(key, key === heldKey ? { waitAfterClaim: true } : options)
      }
      const start = (candidate: typeof campaign) =>
        startSyntheticRun({
          store,
          workspaceRoot: root,
          campaignId: candidate.id,
          expectedVersion: candidate.version,
          dispatchKey: candidate.id,
          daemonBackend: { daemon },
        })

      const first = start(campaign)
      for (let i = 0; i < 200 && daemon.query(heldKey)?.status !== 'running'; i++)
        await Bun.sleep(10)
      expect(daemon.query(heldKey)?.status).toBe('running')

      const second = start(queuedCampaign)
      for (let i = 0; i < 50 && !getResearchCampaign(store, queuedCampaign.id)?.attempts[0]; i++)
        await Bun.sleep(10)
      const queuedAttempt = getResearchCampaign(store, queuedCampaign.id)!.attempts[0]!
      await Bun.sleep(100)
      expect(daemon.query(queuedAttempt.id)?.status).toBe('queued')
      expect(launches.filter((key) => key === queuedAttempt.id)).toHaveLength(0)

      for (const candidate of [campaign, queuedCampaign]) {
        const current = getResearchCampaign(store, candidate.id)!
        cancelSyntheticRun({
          store,
          campaignId: candidate.id,
          expectedVersion: current.version,
          attemptId: current.attempts[0]!.id,
          daemonBackend: { daemon },
        })
      }
      await Promise.all([first, second])
    } finally {
      daemon.close()
      store.close()
    }
  })

  test('records an expired worker as unknown until a terminal daemon observation is confirmed', async () => {
    const { store, root, campaign } = await fresh()
    const daemon = new JobDaemon({
      dbPath: join(root, 'daemon.sqlite'),
      outputRoot: join(root, 'daemon-output'),
    })
    const realNow = Date.now
    let worker: Bun.Subprocess | undefined
    try {
      const launch = daemon.launchWorker.bind(daemon)
      let releaseLaunch!: () => void
      const launchHeld = new Promise<void>((resolve) => {
        releaseLaunch = resolve
      })
      daemon.launchWorker = async (key) => {
        const launched = await launch(key, { waitAfterClaim: true })
        worker = launched
        await launchHeld
        return launched
      }
      const pending = startSyntheticRun({
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'lease-expiry',
        daemonBackend: { daemon },
      })
      let attemptId = ''
      for (let i = 0; i < 200; i++) {
        attemptId = getResearchCampaign(store, campaign.id)!.attempts[0]?.id ?? ''
        if (daemon.query(attemptId)?.status === 'running') break
        await Bun.sleep(10)
      }
      expect(daemon.query(attemptId)?.status).toBe('running')

      Date.now = () => realNow() + 60_001
      releaseLaunch()
      const result = await pending
      expect(result).toMatchObject({ ok: false, code: 'execution_unknown', attemptId })
      expect(getResearchCampaign(store, campaign.id)!.attempts[0]).toMatchObject({
        id: attemptId,
        status: 'unknown',
      })
    } finally {
      Date.now = realNow
      worker?.kill()
      await worker?.exited
      daemon.close()
      store.close()
    }
  }, 10_000)
})
