import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

import {
  cliPreparationAdapterConfigHash,
  cliPreparationExecutableHash,
} from './cli-preparation-job.ts'
import { createRemoteDaemonService } from './remote-daemon-service.ts'

test('remote authority authenticates and strictly validates epoch-bound close-unstarted requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-remote-closure-'))
  const token = 'd'.repeat(48)
  const service = createRemoteDaemonService({
    authorityId: 'closure',
    token,
    port: 0,
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'outputs'),
  })
  const endpoint = `http://127.0.0.1:${service.port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  try {
    expect((await fetch(`${endpoint}/identity`)).status).toBe(401)
    const identityResponse = await fetch(`${endpoint}/identity`, { headers })
    expect(identityResponse.headers.get('x-oph-authority-id')).toBe('closure')
    const identity = (await identityResponse.json()) as {
      identity: { schema: string; epoch: string }
    }
    expect(identity.identity.schema).toBe('research-authority-identity-v1')
    expect(
      (
        await fetch(`${endpoint}/close-unstarted`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedEpoch: identity.identity.epoch }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${endpoint}/close-unstarted`, {
          method: 'POST',
          headers,
          body: 'x'.repeat(5000),
        })
      ).status,
    ).toBe(413)
    const request = {
      expectedEpoch: identity.identity.epoch,
      dispatchKey: 'late-remote-submit',
      specHash: `sha256:${'c'.repeat(64)}`,
    }
    const closed = await fetch(`${endpoint}/close-unstarted`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    })
    expect(closed.headers.get('x-oph-authority-id')).toBe('closure')
    expect(await closed.json()).toMatchObject({
      authorityId: 'closure',
      proof: { ...request, outcome: 'not_started' },
    })
    expect(
      (
        await fetch(`${endpoint}/close-unstarted`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...request, expectedEpoch: 'z'.repeat(32) }),
        })
      ).status,
    ).toBe(409)
  } finally {
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('actual HTTP daemon rejects an A-epoch v3 submit and cancel after rebuild to B', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-remote-epoch-'))
  const token = 'e'.repeat(48)
  const cli = join(root, 'fixture-cli')
  await writeFile(cli, '#!/bin/sh\nexit 0\n')
  await chmod(cli, 0o755)
  const adapter = {
    deviceId: 'fixture-device',
    kind: 'codex-exec' as const,
    executable: cli,
    binaryHash: cliPreparationExecutableHash(cli),
    id: 'fixture-adapter',
    model: 'fixture-model',
  }
  const cliPreparation = {
    backendPolicyHash: `sha256:${'a'.repeat(64)}`,
    workspaceRoot: root,
    workspaceScope: '.',
    credentialHome: join(root, 'credentials'),
    adapters: [adapter],
  }
  const config = {
    authorityId: 'epoch-fixture',
    token,
    port: 0,
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'outputs'),
    cliPreparation,
  }
  const first = createRemoteDaemonService(config)
  let second: ReturnType<typeof createRemoteDaemonService> | undefined
  try {
    const firstEndpoint = `http://127.0.0.1:${first.port}`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const identity = (await (await fetch(`${firstEndpoint}/identity`, { headers })).json()) as {
      identity: { epoch: string }
    }
    first.close()
    await rm(config.dbPath)
    second = createRemoteDaemonService(config)
    const spec = {
      version: 3 as const,
      dispatchKey: 'epoch-race',
      campaignId: 'campaign',
      taskRevisionId: 'task',
      templateId: 'synthetic-summary-v1' as const,
      inputHash: `sha256:${'b'.repeat(64)}`,
      backendPolicyHash: cliPreparation.backendPolicyHash,
      resource: { cpu: 1 as const, memoryMb: 256 },
      lease: { ownerId: 'fixture', token: 'lease', fence: 1, expiresAt: Date.now() + 60_000 },
      execution: {
        adapter: 'cli-preparation-v1' as const,
        preparationId: 'preparation',
        candidateId: 'candidate',
        clientDispatchKey: 'client-key',
        adapterId: adapter.id,
        adapterConfigHash: cliPreparationAdapterConfigHash(adapter),
        model: adapter.model,
        instructions: 'candidate only',
        configHash: `sha256:${'c'.repeat(64)}`,
        deviceId: adapter.deviceId,
        maxRuntimeMs: 1_000,
        maxCost: 1,
      },
    }
    const secondEndpoint = `http://127.0.0.1:${second.port}`
    expect(
      (
        await fetch(`${secondEndpoint}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify(spec),
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await fetch(`${secondEndpoint}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedEpoch: identity.identity.epoch, spec }),
        })
      ).status,
    ).toBe(409)
    expect(second.daemon.query(spec.dispatchKey)).toBeNull()

    const epochB = second.daemon.identity().epoch
    expect(
      (
        await fetch(`${secondEndpoint}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedEpoch: epochB, spec }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${secondEndpoint}/cancel/${spec.dispatchKey}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedEpoch: identity.identity.epoch }),
        })
      ).status,
    ).toBe(409)
    expect(second.daemon.query(spec.dispatchKey)?.status).toBe('queued')
  } finally {
    first.close()
    second?.close()
    await rm(root, { recursive: true, force: true })
  }
})

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
    const authorityIdentity = await client.identity()
    expect(
      await client.closeUnstarted({
        expectedEpoch: authorityIdentity.epoch,
        dispatchKey: 'fenced-before-submit',
        specHash: `sha256:${'e'.repeat(64)}`,
      }),
    ).toMatchObject({ outcome: 'not_started', expectedEpoch: authorityIdentity.epoch })
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
