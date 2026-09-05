import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { handleResearchApi } from '../api/research.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { EventBus } from '../bus.ts'

test('remote authority enforces lease expiry without a connected submitting client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-remote-expiry-'))
  const service = createRemoteDaemonService({
    authorityId: 'expiry',
    token: 'c'.repeat(48),
    port: 0,
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'outputs'),
  })
  let worker: Bun.Subprocess | undefined
  try {
    service.daemon.submit({
      version: 1,
      dispatchKey: 'expires',
      campaignId: 'campaign',
      taskRevisionId: 'task',
      templateId: 'synthetic-summary-v1',
      inputHash: fixedResearchTemplate().execute().inputHash,
      resource: { cpu: 1, memoryMb: 256 },
      lease: { ownerId: 'disconnected', token: 'lease', fence: 1, expiresAt: Date.now() + 500 },
    })
    worker = await service.daemon.launchWorker('expires', { waitAfterClaim: true })
    for (let i = 0; i < 150 && service.daemon.query('expires')?.status !== 'cancelled'; i++)
      await Bun.sleep(20)
    expect(service.daemon.query('expires')?.status).toBe('cancelled')
    await worker.exited
    expect(service.daemon.hasAvailableSlot()).toBe(true)
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill()
      await worker.exited
    }
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { createRemoteDaemonService } from './remote-daemon-service.ts'
import { sha256 } from './skill-lock.ts'
import { createSshDaemonClientForTest } from './ssh-daemon-client.ts'
import { reconcileSyntheticRun, startSyntheticRun } from './synthetic-runner.ts'
import { fixedResearchTemplate } from './template-registry.ts'

test('remote authority executes real child, preserves lost acknowledgement, and reconciles without resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-remote-authority-'))
  const store = new Store({ path: ':memory:' })
  const token = 'a'.repeat(48)
  const service = createRemoteDaemonService({
    authorityId: 'test-remote',
    token,
    port: 0,
    dbPath: join(root, 'remote.sqlite'),
    outputRoot: join(root, 'outputs'),
  })
  const identityFile = join(root, 'identity'),
    knownHostsFile = join(root, 'known_hosts')
  await writeFile(identityFile, 'test fixture key; never sent')
  await writeFile(knownHostsFile, 'test-host-pinned')
  const client = createSshDaemonClientForTest(
    {
      host: 'test.example',
      user: 'runner',
      port: 22,
      identityFile,
      knownHostsFile,
      knownHostsHash: sha256('test-host-pinned'),
      remotePort: service.port,
      authorityId: 'test-remote',
      token,
    },
    async () => ({ endpoint: `http://127.0.0.1:${service.port}`, close() {} }),
  )
  const backend = { kind: 'ssh-daemon' as const, daemon: client }
  try {
    const ws = upsertWorkspace(store, root, 'remote-test')
    const parent = createConversation(store, {
      workspaceId: ws.id,
      provider: 'none',
      model: 'none',
    })
    const made = createResearchCampaign(store, {
      workspaceId: ws.id,
      parentConversationId: parent.id,
      goal: 'fixed remote synthetic',
      inputs: {},
      policy: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'create',
    })
    if (!made.ok) throw new Error(made.message)
    const plan = fixedResearchTemplate('synthetic-training-evaluation-v1')
    const task = mutateResearchCampaign(store, made.campaign.id, {
      expectedVersion: 1,
      idempotencyKey: 'task',
      command: {
        kind: 'declareSyntheticTask',
        taskId: 'remote-evaluation',
        templateId: plan.id,
        inputHash: plan.execute().inputHash,
        artifactVersionIds: [],
        skillBinding: plan.binding,
      },
    })
    if (!task.ok) throw new Error(task.message)
    const taskId = task.campaign.taskRevisions[0]!.id
    const denied = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: made.campaign.id,
      expectedVersion: task.campaign.version,
      templateId: plan.id,
      taskRevisionId: taskId,
      dispatchKey: 'no-approval',
      daemonBackend: backend,
    })
    expect(denied).toMatchObject({ ok: false, code: 'approval_required' })
    const approved = mutateResearchCampaign(store, made.campaign.id, {
      expectedVersion: task.campaign.version,
      idempotencyKey: 'approve',
      command: {
        kind: 'approve',
        bundleHash: task.campaign.bundleHash,
        reviewer: { reviewerId: 'test-only', proofId: crypto.randomUUID(), verifiedAt: Date.now() },
        scope: {
          kind: 'execution',
          taskRevisionId: taskId,
          dispatchKey: 'remote-once',
          artifactVersionIds: [],
          currency: 'USD',
          maxCost: 0,
          expiresAt: Date.now() + 60_000,
          backendPolicyHash: client.backendPolicyHash,
        },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    let submits = 0
    const realSubmit = client.submit.bind(client)
    client.submit = async (spec) => {
      submits++
      await realSubmit(spec)
      throw new Error('simulated lost submit acknowledgement')
    }
    const url = new URL(`http://localhost/api/research/campaigns/${made.campaign.id}/synthetic`)
    const deps = {
      store,
      workspaceRoot: root,
      workspaceId: ws.id,
      bus: new EventBus(),
      researchExecutionDevices: [{ id: 'selected-device', authority: client }],
    } as unknown as ApiRequestDeps
    const requestBody = {
      expectedVersion: approved.campaign.version,
      templateId: plan.id,
      taskRevisionId: taskId,
      dispatchKey: 'remote-once',
      approvalId: approved.campaign.approvals.at(-1)!.id,
    }
    const refused = await handleResearchApi(
      url,
      new Request(url.toString(), {
        method: 'POST',
        body: JSON.stringify({ ...requestBody, approvalId: 'unapproved-device' }),
      }),
      deps,
    )
    expect(refused?.status).toBe(403)
    expect(submits).toBe(0)
    const response = await handleResearchApi(
      url,
      new Request(url.toString(), { method: 'POST', body: JSON.stringify(requestBody) }),
      deps,
    )
    const started = await response!.json()
    expect(started).toMatchObject({ ok: false, code: 'execution_unknown' })
    const attempt = getResearchCampaign(store, made.campaign.id)!.attempts[0]!
    expect(attempt).toMatchObject({
      backend: 'ssh-daemon',
      status: 'unknown',
      backendPolicyHash: client.backendPolicyHash,
    })
    for (let i = 0; i < 100 && service.daemon.query(attempt.id)?.status !== 'completed'; i++)
      await Bun.sleep(20)
    expect(service.daemon.query(attempt.id)?.status).toBe('completed')
    const current = getResearchCampaign(store, made.campaign.id)!
    const recovered = await reconcileSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: current.id,
      expectedVersion: current.version,
      attemptId: attempt.id,
      daemonBackend: backend,
    })
    expect(recovered).toMatchObject({ ok: true })
    expect(submits).toBe(1)
    expect(getResearchCampaign(store, current.id)!.attempts).toHaveLength(1)
    expect(getResearchCampaign(store, current.id)!.artifactVersions[0]?.validation).toBeDefined()
    const projection = await client.query(attempt.id)
    expect(projection?.outputPath).toBeNull()
  } finally {
    client.close()
    service.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
