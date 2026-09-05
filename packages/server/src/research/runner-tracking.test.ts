import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResearchCommand } from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { buildEvidencePack } from './evidence-session.ts'
import { JobDaemon } from './job-daemon.ts'
import {
  captureRunnerTracking,
  type RunnerTrackingConfig,
  validateRunnerTrackingReceipt,
} from './runner-tracking.ts'
import { sha256 } from './skill-lock.ts'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { startSyntheticRun } from './synthetic-runner.ts'
import { fixedResearchTemplate } from './template-registry.ts'

test('real worker collects MLflow and committed DVC metadata into the same verified artifact and EvidencePack', async () => {
  const root = await mkdtemp(join(resolve('.tmp'), 'tracking-runner-'))
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  function git(args: string[]) {
    const result = Bun.spawnSync(['git', '-C', root, ...args], {
      env: gitEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error('Isolated Git fixture setup failed')
    return result.stdout.toString().trim()
  }
  const runId = 'a'.repeat(32)
  const canary = 'patient-metadata-canary'
  const authorization = 'Bearer tracking-test-secret'
  let calls = 0
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      calls++
      expect(new URL(request.url).searchParams.get('run_id')).toBe(runId)
      expect(request.headers.get('authorization')).toBe(authorization)
      return Response.json({
        run: {
          info: { run_id: runId, status: 'FINISHED', artifact_uri: `file:///${canary}` },
          data: {
            metrics: [{ key: 'auroc', value: 0.8 }],
            params: [{ key: 'seed', value: '42' }],
            tags: [{ key: 'patient', value: canary }],
          },
        },
      })
    },
  })
  const store = new Store({ path: ':memory:' })
  let daemon: JobDaemon | undefined
  try {
    git(['init', '--quiet'])
    const lockBytes = `schema: '2.0'\nstages:\n  train:\n    deps:\n    - path: ${canary}\n`
    await writeFile(join(root, 'dvc.lock'), lockBytes)
    git(['add', '--', 'dvc.lock'])
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'synthetic metadata',
    ])
    const revision = git(['rev-parse', 'HEAD'])
    const tracking: RunnerTrackingConfig = {
      schema: 'runner-tracking-config-v1',
      dataClass: 'synthetic',
      mlflow: [
        {
          referenceId: crypto.randomUUID(),
          baseUrl: upstream.url.href,
          runId,
          authorization,
          metrics: { auroc: { min: 0, max: 1 } },
          numericParams: { seed: { min: 0, max: 100 } },
        },
      ],
      dvc: [{ referenceId: crypto.randomUUID(), repositoryRoot: root, revision }],
    }
    daemon = new JobDaemon({
      dbPath: join(root, 'jobs.sqlite'),
      outputRoot: join(root, 'outputs'),
      tracking,
    })
    const capturedHash = daemon.trackingPolicyHash
    if (!capturedHash) throw new Error('Tracking policy was not captured')
    tracking.mlflow[0]!.runId = 'mutated-after-startup'
    const workspace = upsertWorkspace(store, root, 'tracking-fixture')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'fixture',
      model: 'fixture',
    })
    const created = createResearchCampaign(store, {
      idempotencyKey: 'tracking-campaign',
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'synthetic tracking fixture',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
    })
    if (!created.ok) throw new Error(created.message)
    let campaign = created.campaign
    function mutate(command: ResearchCommand) {
      const result = mutateResearchCampaign(store, campaign.id, {
        expectedVersion: campaign.version,
        idempotencyKey: crypto.randomUUID(),
        command,
      })
      if (!result.ok) throw new Error(result.message)
      campaign = result.campaign
    }
    const template = fixedResearchTemplate('synthetic-summary-v1')
    mutate({
      kind: 'declareSyntheticTask',
      taskId: 'tracked-task',
      inputHash: template.execute().inputHash,
      artifactVersionIds: [],
      skillBinding: template.binding,
    })
    const taskRevisionId = campaign.taskRevisions[0]!.id
    const scope = {
      kind: 'execution' as const,
      expiresAt: Date.now() + 60_000,
      currency: 'USD',
      maxCost: 0,
      taskRevisionId,
      dispatchKey: 'tracked',
      artifactVersionIds: [],
    }
    const reviewer = { reviewerId: 'test-reviewer', proofId: 'fixture', verifiedAt: Date.now() }
    mutate({
      kind: 'approve',
      approvalId: 'untracked-approval',
      bundleHash: campaign.bundleHash,
      reviewer,
      scope,
    })
    const request = {
      store,
      workspaceRoot: root,
      campaignId: created.campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'tracked',
      taskRevisionId,
      requireApproval: true,
      approvalId: 'untracked-approval',
      daemonBackend: { daemon },
    }
    const refused = await startSyntheticRun(request)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('approval_required')
    expect(calls).toBe(0)
    mutate({
      kind: 'approve',
      approvalId: 'tracked-approval',
      bundleHash: campaign.bundleHash,
      reviewer: { ...reviewer, proofId: 'tracking-fixture' },
      scope: { ...scope, trackingPolicyHash: capturedHash },
    })
    request.expectedVersion = campaign.version
    request.approvalId = 'tracked-approval'
    const completed = await startSyntheticRun(request)
    if (!completed.ok) throw new Error(completed.error)
    const attempt = completed.campaign.attempts[0]!
    expect(attempt.trackingPolicyHash).toBe(capturedHash)
    expect(attempt.jobSpec?.trackingPolicyHash).toBe(capturedHash)
    const protocol = syntheticProtocol(store, root, created.campaign.id)
    const receipt = await protocol.receipt(attempt.id)
    expect(receipt.tracking?.workerPid).not.toBe(process.pid)
    expect(receipt.tracking?.sources).toMatchObject([
      {
        source: 'mlflow',
        metrics: { auroc: 0.8 },
        numericParams: { seed: 42 },
        verification: 'provider-reported',
      },
      {
        source: 'dvc',
        revision,
        lockSha256: sha256(lockBytes),
        lockByteLength: Buffer.byteLength(lockBytes),
        verification: 'git-lock-bytes',
      },
    ])
    const pack = await buildEvidencePack(store, root, created.campaign.id, [attempt.id])
    expect(pack.reports[0]?.tracking).toEqual(receipt.tracking)
    const serialized = JSON.stringify(pack)
    for (const excluded of [canary, runId, authorization, root])
      expect(serialized).not.toContain(excluded)
    expect((await startSyntheticRun(request)).ok).toBe(true)
    expect(calls).toBe(1)
    const artifact = completed.campaign.artifactVersions[0]!
    const path = fileURLToPath(artifact.uri)
    const bytes = await readFile(path)
    expect(sha256(bytes)).toBe(receipt.contentHash)
    const altered = JSON.parse(bytes.toString())
    altered.tracking.sources[0].metrics.auroc = 0.7
    await writeFile(path, JSON.stringify(altered))
    await expect(protocol.receipt(attempt.id)).rejects.toThrow('字节已变化')
    await writeFile(path, bytes)
    await writeFile(join(root, 'dvc.lock'), 'changed working copy')
    expect((await protocol.receipt(attempt.id)).tracking).toEqual(receipt.tracking)
    expect(calls).toBe(1)
    expect(daemon.query(attempt.id)?.status).toBe('completed')
    const raw = structuredClone(receipt.tracking!) as unknown as {
      sources: Record<string, unknown>[]
    }
    raw.sources[0]!.artifact_uri = 'file:///private'
    expect(() => validateRunnerTrackingReceipt(raw)).toThrow('Unexpected tracking fields')
  } finally {
    daemon?.close()
    store.close()
    upstream.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('synthetic startup policy cannot admit a clinical mode or arbitrary source fields', () => {
  expect(() =>
    captureRunnerTracking({
      schema: 'runner-tracking-config-v1',
      dataClass: 'clinical',
      mlflow: [],
      dvc: [],
    }),
  ).toThrow()
  expect(() =>
    captureRunnerTracking({
      schema: 'runner-tracking-config-v1',
      dataClass: 'synthetic',
      mlflow: [],
      dvc: [],
      endpoint: 'https://arbitrary.test',
    }),
  ).toThrow()
})

test('tracking source failure leaves no verified artifact and replay never refetches', async () => {
  const root = await mkdtemp(join(resolve('.tmp'), 'tracking-failure-'))
  let calls = 0
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++
      return new Response('private-upstream-error', { status: 503 })
    },
  })
  const store = new Store({ path: ':memory:' })
  const daemon = new JobDaemon({
    dbPath: join(root, 'jobs.sqlite'),
    outputRoot: join(root, 'outputs'),
    tracking: {
      schema: 'runner-tracking-config-v1',
      dataClass: 'synthetic',
      dvc: [],
      mlflow: [
        {
          referenceId: crypto.randomUUID(),
          baseUrl: upstream.url.href,
          runId: 'a'.repeat(32),
          metrics: {},
          numericParams: {},
        },
      ],
    },
  })
  try {
    const workspace = upsertWorkspace(store, root, 'tracking-failure')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'fixture',
      model: 'fixture',
    })
    const created = createResearchCampaign(store, {
      idempotencyKey: 'failure',
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'synthetic source failure',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
    })
    if (!created.ok) throw new Error(created.message)
    const request = {
      store,
      workspaceRoot: root,
      campaignId: created.campaign.id,
      expectedVersion: created.campaign.version,
      dispatchKey: 'source-failure',
      daemonBackend: { daemon },
    }
    const result = await startSyntheticRun(request)
    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
    if (!result.ok) {
      expect(result.campaign?.artifactVersions).toHaveLength(0)
      expect(result.campaign?.attempts[0]?.status).toBe('interrupted')
      expect(JSON.stringify(result)).not.toContain('private-upstream-error')
    }
    await startSyntheticRun(request)
    expect(calls).toBe(1)
  } finally {
    daemon.close()
    store.close()
    upstream.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
