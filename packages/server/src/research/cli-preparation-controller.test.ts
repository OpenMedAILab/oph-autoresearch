import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store as SqlStore,
  type Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { readCliCandidateView } from './cli-candidate-view.ts'
import { candidateReceipt } from './cli-preparation-candidate.ts'
import { CliPreparationController, type CliPreparationRoute } from './cli-preparation-controller.ts'
import type { CliPreparationJobSpec } from './cli-preparation-job.ts'
import type { DurableJob } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const inputHash = `sha256:${'a'.repeat(64)}`
const adapterConfigHash = `sha256:${'b'.repeat(64)}`
const backendPolicyHash = `sha256:${'c'.repeat(64)}`

function job(spec: CliPreparationJobSpec, status: DurableJob['status']): DurableJob {
  return {
    spec,
    specHash: sha256(canonicalJson(spec)),
    status,
    outputPath: null,
    contentHash: null,
    error: null,
  }
}

class FakeAuthority {
  submitted: CliPreparationJobSpec[] = []
  queried: string[] = []
  current: DurableJob | null = null
  unavailable = false
  cancelKeepsRemoteState = false
  receiptBytes = new Uint8Array()
  receiptBlock: Promise<void> | null = null
  onReceipt: (() => void) | null = null
  readonly backendPolicyHash = backendPolicyHash
  submit(spec: CliPreparationJobSpec) {
    this.submitted.push(spec)
    this.current = job(spec, 'queued')
    return this.current
  }
  query(key: string) {
    this.queried.push(key)
    if (this.unavailable) throw new Error('transport unavailable')
    return this.current?.spec.dispatchKey === key ? this.current : null
  }
  cancel(key: string) {
    if (this.current?.spec.dispatchKey === key && !this.cancelKeepsRemoteState)
      this.current = { ...this.current, status: 'cancelled' }
    return this.current
  }
  async receipt(_key: string) {
    this.onReceipt?.()
    if (this.receiptBlock) await this.receiptBlock
    return this.receiptBytes
  }
}

function route(authority: FakeAuthority, configHash = adapterConfigHash): CliPreparationRoute {
  return {
    id: 'fixture-route',
    label: 'Fixture route',
    deviceId: 'fixture-device',
    adapterId: 'fixture-adapter',
    model: 'fixture-model',
    adapterConfigHash: configHash,
    authority,
  }
}

function draft(spec: CliPreparationJobSpec) {
  const code = 'export const candidate = 1\n'
  const patch = null
  return {
    schema: 'research-cli-preparation-draft-v1' as const,
    taskRevisionId: spec.taskRevisionId,
    specHash: `sha256:${'d'.repeat(64)}`,
    adapter: { id: spec.execution.adapterId, model: spec.execution.model, identity: 'fixture' },
    inputHash: `sha256:${'d'.repeat(64)}`,
    configHash: spec.execution.adapterConfigHash,
    contentHash: sha256(canonicalJson({ code, patch })),
    code,
    patch,
    usage: null,
    humanApprovalRequired: true as const,
  }
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function setup(store: Store, root: string) {
  const workspace = upsertWorkspace(store, root, 'fixture')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
    title: 'fixture',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'create',
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'fixture campaign',
    policy: { blinded: true },
    inputs: { modality: 'OCT' },
    budget: { currency: 'USD', limit: 10 },
  })
  if (!created.ok) throw new Error(created.message)
  const task = mutateResearchCampaign(store, created.campaign.id, {
    idempotencyKey: 'task',
    expectedVersion: created.campaign.version,
    command: {
      kind: 'declareSyntheticTask',
      taskId: 'fixture_task',
      inputHash,
      artifactVersionIds: [],
    },
  })
  if (!task.ok) throw new Error(task.message)
  return { workspace, campaign: task.campaign, task: task.campaign.taskRevisions[0]! }
}

test('controller submits one approved immutable attempt and records only a candidate receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    const controller = new CliPreparationController(store, [route(authority)], () => {})
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-1',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'return a candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    await expect(
      controller.submit(scope, {
        preparationId: proposed.preparationId,
        approvalId: 'missing',
        expectedVersion: proposed.campaign.version,
      }),
    ).rejects.toThrow('精确且未消费')
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        approvalId: 'human-approval',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    const accepted = await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: 'human-approval',
      expectedVersion: approved.campaign.version,
    })
    expect(accepted.replayed).toBe(false)
    const retry = await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: 'human-approval',
      expectedVersion: accepted.campaign.version,
    })
    expect(retry.replayed).toBe(true)
    await waitFor(() => authority.submitted[0], 'transport submit')
    expect(authority.submitted).toHaveLength(1)
    const spec = authority.submitted[0]!
    authority.receiptBytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft(spec))))
    authority.current = job(spec, 'completed')
    const completed = await waitFor(() => {
      const current = getResearchCampaign(store, campaign.id)
      return current?.cliPreparations?.[0]?.status === 'candidate' ? current : undefined
    }, 'candidate completion')
    expect(completed.taskRevisions[0]!.status).toBe('pending')
    expect(completed.cliPreparations?.[0]?.actualCost).toBeNull()
    expect(completed.artifactVersions[0]?.kind).toBe('cli_preparation_candidate')
    expect(await readCliCandidateView(completed, root, proposed.preparationId)).toMatchObject({
      code: draft(spec).code,
      patch: null,
      formalExecutionAvailable: false,
      quarantined: false,
    })
    await writeFile(fileURLToPath(completed.artifactVersions[0]!.uri), '{}')
    await expect(readCliCandidateView(completed, root, proposed.preparationId)).rejects.toThrow(
      '候选内容已变化',
    )
    const removedRouteController = new CliPreparationController(
      store,
      [route(authority, `sha256:${'f'.repeat(64)}`)],
      () => {},
    )
    const queriesBeforeTerminalRecovery = authority.queried.length
    expect(removedRouteController.recover(scope)).toEqual({ attemptIds: [] })
    await Bun.sleep(0)
    expect(authority.queried).toHaveLength(queriesBeforeTerminalRecovery)
    removedRouteController.close()
    controller.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('quarantines a verified completed receipt when local cancellation wins admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    authority.cancelKeepsRemoteState = true
    const controller = new CliPreparationController(store, [route(authority)], () => {})
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-cancelled-result',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    const accepted = await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: approved.campaign.approvals[0]!.id,
      expectedVersion: approved.campaign.version,
    })
    const spec = await waitFor(() => authority.submitted[0], 'transport submit')
    authority.receiptBytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft(spec))))
    authority.current = job(spec, 'completed')
    await controller.cancel(scope, accepted.attemptId)
    const quarantined = await waitFor(() => {
      const current = getResearchCampaign(store, campaign.id)
      return current?.attempts[0]?.resultDisposition === 'quarantined' ? current : undefined
    }, 'quarantined completion')
    expect(quarantined.attempts[0]).toMatchObject({
      status: 'cancelled',
      executionOutcome: 'completed',
      resultDisposition: 'quarantined',
    })
    expect(quarantined.taskRevisions[0]!.status).toBe('pending')
    expect(quarantined.cliPreparations?.[0]?.status).toBe('claimed')
    expect(quarantined.cliPreparations?.[0]?.actualCost).toBeNull()
    expect(quarantined.artifactVersions[0]?.kind).toBe('cli_preparation_quarantined_candidate')
    expect(await readCliCandidateView(quarantined, root, proposed.preparationId)).toMatchObject({
      quarantined: true,
      formalExecutionAvailable: false,
    })
    controller.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('quarantines a completed receipt for a historically revoked consumed approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    const controller = new CliPreparationController(store, [route(authority)], () => {})
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-historical-revocation',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: approved.campaign.approvals[0]!.id,
      expectedVersion: approved.campaign.version,
    })
    const spec = await waitFor(() => authority.submitted[0], 'transport submit')
    const historical = getResearchCampaign(store, campaign.id)!
    expect(historical.attempts[0]!.cancelRequestedAt).toBeNull()
    store.db.query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?').run(
      JSON.stringify({
        ...historical,
        approvals: historical.approvals.map((item) =>
          item.consumedBy === historical.attempts[0]!.id
            ? { ...item, status: 'revoked' as const }
            : item,
        ),
      }),
      campaign.id,
    )
    authority.receiptBytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft(spec))))
    authority.current = job(spec, 'completed')
    const quarantined = await waitFor(() => {
      const current = getResearchCampaign(store, campaign.id)
      return current?.attempts[0]?.resultDisposition === 'quarantined' ? current : undefined
    }, 'historically revoked receipt quarantine')
    expect(quarantined.attempts[0]).toMatchObject({
      status: 'cancelled',
      cancelRequestedAt: null,
      executionOutcome: 'completed',
      resultDisposition: 'quarantined',
    })
    expect(quarantined.cliPreparations?.[0]?.status).toBe('claimed')
    expect(quarantined.artifactVersions[0]?.kind).toBe('cli_preparation_quarantined_candidate')
    expect(await readCliCandidateView(quarantined, root, proposed.preparationId)).toMatchObject({
      quarantined: true,
      formalExecutionAvailable: false,
    })
    controller.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rechecks cancellation after blocked receipt retrieval before finalizing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    authority.cancelKeepsRemoteState = true
    let releaseReceipt: (() => void) | undefined
    authority.receiptBlock = new Promise<void>((resolve) => {
      releaseReceipt = resolve
    })
    let receiptStarted: (() => void) | undefined
    const receiptStartedPromise = new Promise<void>((resolve) => {
      receiptStarted = resolve
    })
    authority.onReceipt = () => receiptStarted?.()
    const controller = new CliPreparationController(store, [route(authority)], () => {})
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-cancel-during-receipt',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    const accepted = await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: approved.campaign.approvals[0]!.id,
      expectedVersion: approved.campaign.version,
    })
    const spec = await waitFor(() => authority.submitted[0], 'transport submit')
    authority.receiptBytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft(spec))))
    authority.current = job(spec, 'completed')
    await receiptStartedPromise
    await controller.cancel(scope, accepted.attemptId)
    releaseReceipt!()
    const quarantined = await waitFor(() => {
      const current = getResearchCampaign(store, campaign.id)
      return current?.attempts[0]?.resultDisposition === 'quarantined' ? current : undefined
    }, 'receipt-race quarantine')
    expect(quarantined.attempts[0]).toMatchObject({
      status: 'cancelled',
      executionOutcome: 'completed',
      resultDisposition: 'quarantined',
    })
    expect(quarantined.cliPreparations?.[0]?.status).toBe('claimed')
    controller.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile observes the original attempt after an unknown transport state without resubmitting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    authority.unavailable = true
    const controller = new CliPreparationController(store, [route(authority)], () => {})
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-unknown',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    const accepted = await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: approved.campaign.approvals[0]!.id,
      expectedVersion: approved.campaign.version,
    })
    await waitFor(
      () =>
        getResearchCampaign(store, campaign.id)?.attempts[0]?.status === 'unknown'
          ? true
          : undefined,
      'unknown state',
    )
    const changedRoute = new CliPreparationController(
      store,
      [route(authority, `sha256:${'f'.repeat(64)}`)],
      () => {},
    )
    const queriesBeforeMismatchedRecovery = authority.queried.length
    expect(changedRoute.recover(scope)).toEqual({ attemptIds: [accepted.attemptId] })
    await Bun.sleep(0)
    expect(authority.submitted).toHaveLength(1)
    expect(authority.queried).toHaveLength(queriesBeforeMismatchedRecovery)
    authority.unavailable = false
    await controller.reconcile(scope, accepted.attemptId)
    expect(authority.submitted).toHaveLength(1)
    await waitFor(
      () => (authority.queried.includes(accepted.attemptId) ? accepted.attemptId : undefined),
      'recovery query',
    )
    const spec = authority.submitted[0]!
    authority.receiptBytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft(spec))))
    authority.current = job(spec, 'completed')
    await waitFor(
      () =>
        getResearchCampaign(store, campaign.id)?.cliPreparations?.[0]?.status === 'candidate'
          ? true
          : undefined,
      'recovered candidate completion',
    )
    expect(() =>
      controller.propose(
        { ...scope, workspaceId: 'other' },
        {
          expectedVersion: 1,
          idempotencyKey: 'cross-workspace',
          routeId: 'fixture-route',
          taskRevisionId: task.id,
          instructions: 'x',
          maxRuntimeMs: 1,
          maxCost: 1,
          acknowledgeUnknownCost: true,
        },
      ),
    ).toThrow('研究项目不存在')
    await expect(changedRoute.reconcile(scope, accepted.attemptId)).rejects.toThrow('已变化')
    controller.close()
    changedRoute.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rolls back a consumed approval and claimed attempt when binding fails before commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-cli-controller-'))
  const store = new SqlStore({ path: ':memory:' })
  try {
    const { workspace, campaign, task } = setup(store, root)
    const authority = new FakeAuthority()
    let changed = 0
    const controller = new CliPreparationController(
      store,
      [route(authority)],
      () => changed++,
      () => {
        throw new Error('bind fault')
      },
    )
    const scope = { workspaceId: workspace.id, workspaceRoot: root, campaignId: campaign.id }
    const proposed = controller.propose(scope, {
      expectedVersion: campaign.version,
      idempotencyKey: 'proposal-fault',
      routeId: 'fixture-route',
      taskRevisionId: task.id,
      instructions: 'candidate only',
      maxRuntimeMs: 1_000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approval = controller.approval(scope, proposed.preparationId)
    const approved = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.expectedVersion,
      idempotencyKey: approval.idempotencyKey,
      command: {
        kind: 'approve',
        bundleHash: approval.bundleHash,
        scope: approval.scope,
        reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
      },
    })
    if (!approved.ok) throw new Error(approved.message)
    changed = 0
    await expect(
      controller.submit(scope, {
        preparationId: proposed.preparationId,
        approvalId: approved.campaign.approvals[0]!.id,
        expectedVersion: approved.campaign.version,
      }),
    ).rejects.toThrow('bind fault')
    const rolledBack = getResearchCampaign(store, campaign.id)!
    expect(rolledBack.attempts).toEqual([])
    expect(rolledBack.cliPreparations?.[0]).toMatchObject({ status: 'proposed', attemptId: null })
    expect(rolledBack.approvals[0]?.consumedBy).toBeUndefined()
    expect(changed).toBe(0)
    expect(authority.submitted).toEqual([])
    controller.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
