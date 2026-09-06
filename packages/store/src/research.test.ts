/** Coverage: research.ts campaign event writes, projections, approvals, and idempotent recovery. */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalResearchBundle, type ResearchCampaign } from '@oph-autoresearch/core'
import { Store } from './db.ts'
import { createConversation, upsertWorkspace } from './repos.ts'
import {
  canStartControllerRequest,
  controllerApprovalScope,
  costEvidenceApprovalScope,
  createResearchCampaign,
  findRunningSyntheticAttempts,
  getResearchCampaign,
  listResearchCampaigns,
  listResearchEvents,
  mutateResearchCampaign,
  rebuildResearchCampaignProjection,
  recoverRunningSyntheticAttempts,
  researchCostSummary,
  scientificContextHash,
} from './research.ts'

const CONTENT_HASH = `sha256:${'a'.repeat(64)}`
const INPUT_HASH = `sha256:${'c'.repeat(64)}`

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return `sha256:${hasher.digest('hex')}`
}

function cliProposal(taskRevisionId: string, overrides: Record<string, unknown> = {}) {
  const draft = {
    kind: 'proposeCliPreparation' as const,
    preparationId: 'rcp_fixture',
    taskRevisionId,
    dispatchKey: 'prepare-fixture',
    candidateId: 'candidate_fixture',
    adapterId: 'fixture-cli',
    adapterConfigHash: `sha256:${'d'.repeat(64)}`,
    backendPolicyHash: `sha256:${'e'.repeat(64)}`,
    model: 'fixture-model',
    instructions: 'produce a candidate only',
    inputHash: INPUT_HASH,
    deviceId: 'fixture-device-1',
    maxRuntimeMs: 60_000,
    maxCost: 10,
    acknowledgeUnknownCost: true as const,
    ...overrides,
  }
  return {
    ...draft,
    configHash: sha256(
      canonicalJson({
        preparationId: draft.preparationId,
        taskRevisionId: draft.taskRevisionId,
        dispatchKey: draft.dispatchKey,
        candidateId: draft.candidateId,
        adapterId: draft.adapterId,
        adapterConfigHash: draft.adapterConfigHash,
        backendPolicyHash: draft.backendPolicyHash,
        model: draft.model,
        instructions: draft.instructions,
        inputHash: draft.inputHash,
        deviceId: draft.deviceId,
        maxRuntimeMs: draft.maxRuntimeMs,
        maxCost: draft.maxCost,
        acknowledgeUnknownCost: draft.acknowledgeUnknownCost,
      }),
    ),
  }
}

function declareCliTask(store: Store, campaign: ReturnType<typeof created>['campaign']) {
  const result = mutateResearchCampaign(store, campaign.id, {
    idempotencyKey: `declare-cli-${crypto.randomUUID()}`,
    expectedVersion: campaign.version,
    command: {
      kind: 'declareSyntheticTask',
      taskId: `cli-task-${crypto.randomUUID()}`,
      inputHash: INPUT_HASH,
      artifactVersionIds: [],
    },
  })
  if (!result.ok) throw new Error(result.message)
  return result.campaign
}

function approveCliPreparation(
  store: Store,
  campaign: ReturnType<typeof created>['campaign'],
  proposal: ReturnType<typeof cliProposal>,
  idempotencyKey = `approve-cli-${crypto.randomUUID()}`,
) {
  return mutateResearchCampaign(store, campaign.id, {
    idempotencyKey,
    expectedVersion: campaign.version,
    command: {
      kind: 'approve',
      approvalId: `hap-${idempotencyKey}`,
      bundleHash: campaign.bundleHash,
      reviewer: { reviewerId: 'human', proofId: idempotencyKey, verifiedAt: Date.now() },
      scope: {
        kind: 'cli_preparation',
        taskRevisionId: proposal.taskRevisionId as string,
        dispatchKey: proposal.dispatchKey as string,
        configHash: proposal.configHash,
        backendPolicyHash: proposal.backendPolicyHash as string,
        preparationLimits: {
          maxRuntimeMs: proposal.maxRuntimeMs as number,
          cpu: 1,
          memoryMb: 256,
          adapterConfigHash: proposal.adapterConfigHash as string,
          acknowledgeUnknownCost: true,
        },
        artifactVersionIds: [],
        currency: campaign.budget.currency,
        maxCost: proposal.maxCost as number,
        expiresAt: Date.now() + 60_000,
      },
    },
  })
}

function cliPreparationJobSpec(
  campaign: ReturnType<typeof created>['campaign'],
  preparation: NonNullable<ReturnType<typeof created>['campaign']['cliPreparations']>[number],
  attemptId: string,
) {
  return {
    version: 3 as const,
    dispatchKey: attemptId,
    campaignId: campaign.id,
    taskRevisionId: preparation.taskRevisionId,
    templateId: campaign.taskRevisions.find((task) => task.id === preparation.taskRevisionId)!
      .templateId,
    inputHash: preparation.inputHash,
    backendPolicyHash: preparation.backendPolicyHash,
    resource: { cpu: 1 as const, memoryMb: 256 as const },
    lease: { ownerId: 'daemon', token: 'lease-fixture', fence: 1, expiresAt: Date.now() + 60_000 },
    execution: {
      adapter: 'cli-preparation-v1' as const,
      preparationId: preparation.id,
      candidateId: preparation.candidateId,
      clientDispatchKey: preparation.dispatchKey,
      adapterId: preparation.adapterId,
      adapterConfigHash: preparation.adapterConfigHash,
      model: preparation.model,
      instructions: preparation.instructions,
      configHash: preparation.configHash,
      deviceId: preparation.deviceId,
      maxRuntimeMs: preparation.maxRuntimeMs,
      maxCost: preparation.maxCost,
    },
  }
}

function claim(
  store: Store,
  campaignId: string,
  expectedVersion: number,
  dispatchKey = 'dispatch-1',
) {
  return mutateResearchCampaign(store, campaignId, {
    idempotencyKey: `claim-${dispatchKey}`,
    expectedVersion,
    command: { kind: 'claimSynthetic', dispatchKey, inputHash: INPUT_HASH },
  })
}

function fresh(path = ':memory:') {
  return new Store({ path })
}

function created(store: Store) {
  const workspace = upsertWorkspace(store, `/tmp/research-${crypto.randomUUID()}`, 'research')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
    title: 'parent',
  })
  const result = createResearchCampaign(store, {
    idempotencyKey: 'create-1',
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'validate a biomarker',
    policy: { blinded: true },
    inputs: { modality: 'OCT' },
    budget: { currency: 'USD', limit: 100 },
  })
  if (!result.ok) throw new Error(result.message)
  return result
}

function completeReleaseArtifact(store: Store) {
  const campaign = created(store).campaign
  const claimed = claim(store, campaign.id, campaign.version, `release-${crypto.randomUUID()}`)
  if (!claimed.ok) throw new Error(claimed.message)
  const attempt = claimed.campaign.attempts[0]!
  const finished = mutateResearchCampaign(store, campaign.id, {
    idempotencyKey: `finish-release-${attempt.id}`,
    expectedVersion: claimed.campaign.version,
    command: {
      kind: 'finishSynthetic',
      attemptId: attempt.id,
      uri: 'research/release-artifact.json',
      artifactKind: 'synthetic-summary-v1',
      contentHash: CONTENT_HASH,
      validation: {
        inputHash: INPUT_HASH,
        contentHash: CONTENT_HASH,
        byteLength: 1,
        verifiedAt: Date.now(),
      },
    },
  })
  if (!finished.ok) throw new Error(finished.message)
  return finished.campaign
}

function reviewSourceContextHash(campaign: ResearchCampaign) {
  const taskContextHash = sha256(
    canonicalJson({ policy: campaign.policy, inputs: campaign.inputs, budget: campaign.budget }),
  )
  return sha256(
    canonicalJson({
      context: taskContextHash,
      literatureCitations: campaign.literatureCitations ?? [],
    }),
  )
}

function installReleaseReview(
  store: Store,
  campaign: ResearchCampaign,
  input: {
    text?: string
    artifactVersionIds?: string[]
    sourceContextHash?: string
    contentHash?: string
  } = {},
) {
  const artifactVersionIds =
    input.artifactVersionIds ?? campaign.artifactVersions.map((item) => item.id)
  const text =
    input.text ??
    JSON.stringify({
      decision: 'supported',
      claims: [
        { claim: 'The verified artifact supports this bounded release.', artifactVersionIds },
      ],
      limitations: ['Synthetic evidence only.'],
    })
  const review = {
    id: `rmr_release_${crypto.randomUUID()}`,
    dispatchKey: `review-release-${crypto.randomUUID()}`,
    approvalId: `hap-review-${crypto.randomUUID()}`,
    evidencePackHash: `sha256:${'d'.repeat(64)}`,
    configHash: `sha256:${'e'.repeat(64)}`,
    artifactVersionIds,
    currency: campaign.budget.currency,
    reservedCost: 1,
    maxRequests: 2,
    maxOutputTokens: 1024,
    requestCount: 1,
    status: 'done' as const,
    ownerPid: process.pid,
    sourceContextHash: input.sourceContextHash ?? reviewSourceContextHash(campaign),
    text,
    contentHash: input.contentHash ?? sha256(text),
    actualCost: null,
  }
  const snapshot = { ...campaign, modelReviews: [review], bundleHash: '' }
  return replaceCampaignSnapshot(store, snapshot)
}

function replaceCampaignSnapshot(store: Store, campaign: ResearchCampaign) {
  const snapshot = { ...campaign, bundleHash: '' }
  snapshot.bundleHash = sha256(canonicalResearchBundle(snapshot))
  store.db
    .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(snapshot), snapshot.id)
  return getResearchCampaign(store, campaign.id)!
}

function approveRelease(store: Store, campaign: ResearchCampaign, artifactVersionIds: string[]) {
  const approved = mutateResearchCampaign(store, campaign.id, {
    idempotencyKey: `approve-release-${crypto.randomUUID()}`,
    expectedVersion: campaign.version,
    command: {
      kind: 'approve',
      bundleHash: campaign.bundleHash,
      reviewer: {
        reviewerId: 'release-reviewer',
        proofId: crypto.randomUUID(),
        verifiedAt: Date.now(),
      },
      scope: {
        kind: 'release',
        artifactVersionIds,
        currency: campaign.budget.currency,
        maxCost: 1,
        expiresAt: Date.now() + 60_000,
      },
    },
  })
  if (!approved.ok) throw new Error(approved.message)
  return approved.campaign
}

describe('research campaign ledger', () => {
  test('creates a proposal with an event, projection, and outbox row in one write', () => {
    const store = fresh()
    const result = created(store)
    expect(result.campaign.status).toBe('proposal')
    expect(getResearchCampaign(store, result.campaign.id)).toEqual(result.campaign)
    expect(
      listResearchCampaigns(
        store,
        result.campaign.workspaceId,
        result.campaign.parentConversationId,
      ),
    ).toEqual([result.campaign])
    const retried = createResearchCampaign(store, {
      idempotencyKey: 'create-1',
      workspaceId: result.campaign.workspaceId,
      parentConversationId: result.campaign.parentConversationId,
      goal: result.campaign.goal,
      policy: { blinded: true },
      inputs: { modality: 'OCT' },
      budget: { currency: 'USD', limit: 100 },
    })
    expect(retried.ok && retried.replayed).toBe(true)
    const conflict = createResearchCampaign(store, {
      idempotencyKey: 'create-1',
      workspaceId: result.campaign.workspaceId,
      parentConversationId: result.campaign.parentConversationId,
      goal: 'a different goal',
      policy: { blinded: true },
      inputs: { modality: 'OCT' },
      budget: { currency: 'USD', limit: 100 },
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict')
    expect(listResearchEvents(store, result.campaign.id)).toHaveLength(1)
    expect(
      store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM research_outbox').get()
        ?.count,
    ).toBe(1)
    store.close()
  })

  test('legacy idempotent snapshots without synthetic arrays replay as normalized campaigns', () => {
    const store = fresh()
    const result = created(store)
    const legacy = { ...result.campaign } as Record<string, unknown>
    delete legacy.taskRevisions
    delete legacy.attempts
    store.db
      .query(
        `UPDATE research_create_idempotency SET result_snapshot = ?
         WHERE workspace_id = ? AND parent_conversation_id = ? AND idempotency_key = ?`,
      )
      .run(
        JSON.stringify(legacy),
        result.campaign.workspaceId,
        result.campaign.parentConversationId,
        'create-1',
      )
    const replayed = createResearchCampaign(store, {
      idempotencyKey: 'create-1',
      workspaceId: result.campaign.workspaceId,
      parentConversationId: result.campaign.parentConversationId,
      goal: result.campaign.goal,
      policy: { blinded: true },
      inputs: { modality: 'OCT' },
      budget: { currency: 'USD', limit: 100 },
    })
    expect(replayed.ok && replayed.replayed).toBe(true)
    if (replayed.ok) expect(replayed.campaign.taskRevisions).toEqual([])
    if (replayed.ok) expect(replayed.campaign.attempts).toEqual([])
    store.close()
  })

  test('same key returns its original result, while a changed payload is rejected', () => {
    const store = fresh()
    const initial = created(store).campaign
    const first = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'input-1',
      expectedVersion: 1,
      command: { kind: 'setInputs', inputs: { modality: 'fundus' } },
    })
    expect(first.ok).toBe(true)
    const retry = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'input-1',
      expectedVersion: 1,
      command: { kind: 'setInputs', inputs: { modality: 'fundus' } },
    })
    expect(retry.ok && retry.replayed).toBe(true)
    const conflict = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'input-1',
      expectedVersion: 1,
      command: { kind: 'setInputs', inputs: { modality: 'OCTA' } },
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict')
    expect(listResearchEvents(store, initial.id)).toHaveLength(2)
    store.close()
  })

  test('CAS rejects stale mutations without a second event', () => {
    const store = fresh()
    const initial = created(store).campaign
    const changed = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'policy-1',
      expectedVersion: initial.version,
      command: { kind: 'setPolicy', policy: { blinded: false } },
    })
    expect(changed.ok).toBe(true)
    const stale = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'budget-old',
      expectedVersion: initial.version,
      command: { kind: 'setBudget', budget: { currency: 'USD', limit: 200 } },
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('stale_version')
    expect(listResearchEvents(store, initial.id)).toHaveLength(2)
    store.close()
  })

  test('a changed artifact invalidates an approval bound to the old canonical bundle', () => {
    const store = fresh()
    const initial = created(store).campaign
    const approved = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'approval-1',
      expectedVersion: initial.version,
      command: {
        kind: 'approve',
        bundleHash: initial.bundleHash,
        reviewer: { reviewerId: 'human_1', proofId: 'session-proof', verifiedAt: 1 },
      },
    })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.campaign.approvals[0]?.status).toBe('active')
    const artifact = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'artifact-1',
      expectedVersion: approved.campaign.version,
      command: {
        kind: 'recordArtifact',
        artifactId: 'protocol',
        uri: 'research/protocol.yaml',
        artifactKind: 'study_protocol',
        contentHash: CONTENT_HASH,
      },
    })
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect(artifact.campaign.approvals[0]?.status).toBe('invalidated')
    expect(artifact.campaign.artifactVersions[0]).toMatchObject({
      version: 1,
      contentHash: CONTENT_HASH,
    })
    const nextArtifact = mutateResearchCampaign(store, initial.id, {
      idempotencyKey: 'artifact-2',
      expectedVersion: artifact.campaign.version,
      command: {
        kind: 'recordArtifact',
        artifactId: ' protocol ',
        uri: 'research/protocol-v2.yaml',
        artifactKind: 'study_protocol',
        contentHash: `sha256:${'b'.repeat(64)}`,
      },
    })
    expect(nextArtifact.ok).toBe(true)
    if (nextArtifact.ok) expect(nextArtifact.campaign.artifactVersions[1]?.version).toBe(2)
    store.close()
  })

  test('a model-shaped actor field cannot stand in for a trusted reviewer proof', () => {
    const store = fresh()
    const campaign = created(store).campaign
    const denied = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'model-actor',
      expectedVersion: campaign.version,
      command: {
        kind: 'approve',
        bundleHash: campaign.bundleHash,
        actor: 'model',
      } as unknown as { kind: 'approve'; bundleHash: string; reviewer: never },
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('invalid_approval')
    expect(getResearchCampaign(store, campaign.id)?.approvals).toEqual([])
    store.close()
  })

  test('claim creates one fixed synthetic task and never duplicates a dispatch key', () => {
    const store = fresh()
    const campaign = created(store).campaign
    const first = claim(store, campaign.id, campaign.version)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.campaign.taskRevisions[0]).toMatchObject({
      revision: 1,
      stage: 'execution',
      templateId: 'synthetic-summary-v1',
      outputContract: 'synthetic-summary-v1',
      dataClass: 'synthetic',
      inputHash: INPUT_HASH,
    })
    expect(first.campaign.attempts[0]).toMatchObject({
      dispatchKey: 'dispatch-1',
      status: 'running',
    })
    const retried = claim(store, campaign.id, campaign.version)
    expect(retried.ok && retried.replayed).toBe(true)
    if (retried.ok) expect(retried.campaign.attempts).toHaveLength(1)
    const conflict = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'claim-other-input',
      expectedVersion: first.campaign.version,
      command: { kind: 'claimSynthetic', dispatchKey: 'dispatch-1', inputHash: CONTENT_HASH },
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.code).toBe('dispatch_key_conflict')
    store.close()
  })

  test('cancelled or interrupted attempts cannot later complete', () => {
    const store = fresh()
    const campaign = created(store).campaign
    const claimed = claim(store, campaign.id, campaign.version)
    if (!claimed.ok) throw new Error(claimed.message)
    const attemptId = claimed.campaign.attempts[0]!.id
    const cancelled = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'cancel-1',
      expectedVersion: claimed.campaign.version,
      command: { kind: 'requestCancelSynthetic', attemptId },
    })
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    const blockedFinish = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'finish-after-cancel',
      expectedVersion: cancelled.campaign.version,
      command: {
        kind: 'finishSynthetic',
        attemptId,
        contentHash: CONTENT_HASH,
        uri: 'research/synthetic.json',
        artifactKind: 'synthetic_summary',
        validation: {
          inputHash: INPUT_HASH,
          contentHash: CONTENT_HASH,
          byteLength: 1,
          verifiedAt: 1,
        },
      },
    })
    expect(blockedFinish.ok).toBe(false)
    if (!blockedFinish.ok) expect(blockedFinish.code).toBe('cancel_requested')
    const interrupted = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'interrupt-1',
      expectedVersion: cancelled.campaign.version,
      command: { kind: 'interruptSynthetic', attemptId, reason: 'cancelled by user' },
    })
    expect(interrupted.ok).toBe(true)
    if (!interrupted.ok) return
    expect(interrupted.campaign.attempts[0]?.status).toBe('cancelled')
    const afterEnd = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'finish-after-end',
      expectedVersion: interrupted.campaign.version,
      command: {
        kind: 'finishSynthetic',
        attemptId,
        contentHash: CONTENT_HASH,
        uri: 'research/synthetic.json',
        artifactKind: 'synthetic_summary',
        validation: {
          inputHash: INPUT_HASH,
          contentHash: CONTENT_HASH,
          byteLength: 1,
          verifiedAt: 1,
        },
      },
    })
    expect(afterEnd.ok).toBe(false)
    if (!afterEnd.ok) expect(afterEnd.code).toBe('inactive_attempt')
    store.close()
  })

  test('finish rejects validation from an obsolete task input', () => {
    const store = fresh()
    const campaign = created(store).campaign
    const claimed = claim(store, campaign.id, campaign.version)
    if (!claimed.ok) throw new Error(claimed.message)
    const attemptId = claimed.campaign.attempts[0]!.id
    const finish = mutateResearchCampaign(store, campaign.id, {
      idempotencyKey: 'obsolete-input',
      expectedVersion: claimed.campaign.version,
      command: {
        kind: 'finishSynthetic',
        attemptId,
        contentHash: CONTENT_HASH,
        uri: 'research/synthetic.json',
        artifactKind: 'synthetic_summary',
        validation: {
          inputHash: `sha256:${'d'.repeat(64)}`,
          contentHash: CONTENT_HASH,
          byteLength: 1,
          verifiedAt: 1,
        },
      },
    })
    expect(finish.ok).toBe(false)
    if (!finish.ok) expect(finish.code).toBe('invalid_synthetic_finish')
    expect(getResearchCampaign(store, campaign.id)?.attempts[0]?.status).toBe('running')
    store.close()
  })

  test('recovery only ends attempts owned by dead processes', () => {
    const store = fresh()
    const campaign = created(store).campaign
    const claimed = claim(store, campaign.id, campaign.version)
    if (!claimed.ok) throw new Error(claimed.message)
    expect(findRunningSyntheticAttempts(store)).toHaveLength(1)
    expect(recoverRunningSyntheticAttempts(store, { isOwnerAlive: () => true })).toEqual([])
    const recovered = recoverRunningSyntheticAttempts(store, { isOwnerAlive: () => false })
    expect(recovered[0]?.status).toBe('interrupted')
    expect(findRunningSyntheticAttempts(store)).toEqual([])
    store.close()
  })

  test('a claimed synthetic attempt survives restart and is recovered without redispatch', () => {
    const path = join(process.cwd(), '.tmp', 'research-synthetic-restart.sqlite')
    mkdirSync(dirname(path), { recursive: true })
    rmSync(path, { force: true })
    const first = fresh(path)
    const campaign = created(first).campaign
    const claimed = claim(first, campaign.id, campaign.version)
    if (!claimed.ok) throw new Error(claimed.message)
    const attemptId = claimed.campaign.attempts[0]!.id
    first.close()

    const restarted = fresh(path)
    expect(findRunningSyntheticAttempts(restarted).map((entry) => entry.attempt.id)).toEqual([
      attemptId,
    ])
    expect(
      recoverRunningSyntheticAttempts(restarted, { isOwnerAlive: () => false })[0]?.status,
    ).toBe('interrupted')
    expect(getResearchCampaign(restarted, campaign.id)?.attempts).toHaveLength(1)
    expect(findRunningSyntheticAttempts(restarted)).toEqual([])
    restarted.close()
    rmSync(path, { force: true })
  })

  test('reopens and rebuilds the projection from the durable event ledger', () => {
    const path = join(process.cwd(), '.tmp', 'research-ledger-restart.sqlite')
    mkdirSync(dirname(path), { recursive: true })
    rmSync(path, { force: true })
    const first = fresh(path)
    const campaign = created(first).campaign
    first.close()

    const restarted = fresh(path)
    expect(getResearchCampaign(restarted, campaign.id)?.id).toBe(campaign.id)
    restarted.db
      .query(
        "UPDATE research_campaigns SET workspace_id = 'broken', parent_conversation_id = 'broken', snapshot = ? WHERE id = ?",
      )
      .run(JSON.stringify({ broken: true }), campaign.id)
    const rebuilt = rebuildResearchCampaignProjection(restarted, campaign.id)
    expect(rebuilt).toEqual(campaign)
    expect(getResearchCampaign(restarted, campaign.id)).toEqual(campaign)
    expect(
      listResearchCampaigns(restarted, campaign.workspaceId, campaign.parentConversationId),
    ).toEqual([campaign])
    restarted.close()
    rmSync(path, { force: true })
  })

  test('campaign history survives deletion of its parent conversation', () => {
    const store = fresh()
    const campaign = created(store).campaign
    store.db.query('DELETE FROM conversations WHERE id = ?').run(campaign.parentConversationId)
    expect(getResearchCampaign(store, campaign.id)).toEqual(campaign)
    expect(listResearchEvents(store, campaign.id)).toHaveLength(1)
    const retriedCreate = createResearchCampaign(store, {
      idempotencyKey: 'create-1',
      workspaceId: campaign.workspaceId,
      parentConversationId: campaign.parentConversationId,
      goal: campaign.goal,
      policy: { blinded: true },
      inputs: { modality: 'OCT' },
      budget: { currency: 'USD', limit: 100 },
    })
    expect(retriedCreate.ok && retriedCreate.replayed).toBe(true)
    store.close()
  })

  test('rebuild restores a missing projection row from the append-only event ledger', () => {
    const store = fresh()
    const campaign = created(store).campaign
    store.db.exec('PRAGMA foreign_keys = OFF')
    store.db.query('DELETE FROM research_campaigns WHERE id = ?').run(campaign.id)
    store.db.exec('PRAGMA foreign_keys = ON')
    expect(getResearchCampaign(store, campaign.id)).toBeNull()
    expect(rebuildResearchCampaignProjection(store, campaign.id)).toEqual(campaign)
    expect(getResearchCampaign(store, campaign.id)).toEqual(campaign)
    store.close()
  })
})

test('approval display is bound to the ledger research title and exact task revision', () => {
  const store = fresh()
  try {
    const initial = created(store).campaign
    const running = claim(store, initial.id, initial.version)
    if (!running.ok) throw new Error(running.message)
    const campaign = running.campaign
    const task = campaign.taskRevisions[0]!
    const display = { title: campaign.goal, task: task.templateId!, revision: task.revision }
    const approve = (shown: typeof display, key: string) =>
      mutateResearchCampaign(store, campaign.id, {
        expectedVersion: campaign.version,
        idempotencyKey: key,
        command: {
          kind: 'approve',
          bundleHash: campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: key, verifiedAt: Date.now() },
          scope: {
            kind: 'execution',
            taskRevisionId: task.id,
            dispatchKey: 'display-signed-task',
            artifactVersionIds: [],
            currency: campaign.budget.currency,
            maxCost: 0,
            expiresAt: Date.now() + 60000,
            display: shown,
          },
        },
      })
    expect(approve({ ...display, title: 'Another research project' }, 'wrong-title').ok).toBe(false)
    expect(approve({ ...display, task: 'synthetic-retinal-image-v1' }, 'wrong-task').ok).toBe(false)
    expect(approve({ ...display, revision: display.revision + 1 }, 'wrong-revision').ok).toBe(false)
    expect(approve(display, 'correct-display').ok).toBe(true)
  } finally {
    store.close()
  }
})

describe('CLI preparation authorization ledger', () => {
  test('rejects a proposal whose supplied hash omits any frozen authorization field', () => {
    const fields = [
      ['preparationId', 'rcp_other'],
      ['taskRevisionId', 'rtr_other'],
      ['dispatchKey', 'prepare-other'],
      ['candidateId', 'candidate_other'],
      ['adapterId', 'other-cli'],
      ['adapterConfigHash', CONTENT_HASH],
      ['backendPolicyHash', CONTENT_HASH],
      ['model', 'other-model'],
      ['instructions', 'different instruction'],
      ['inputHash', CONTENT_HASH],
      ['deviceId', 'device-other'],
      ['maxRuntimeMs', 120_000],
      ['maxCost', 11],
      ['acknowledgeUnknownCost', false],
    ] as const
    for (const [field, value] of fields) {
      const store = fresh()
      try {
        const taskCampaign = declareCliTask(store, created(store).campaign)
        const valid = cliProposal(taskCampaign.taskRevisions[0]!.id)
        const denied = mutateResearchCampaign(store, taskCampaign.id, {
          idempotencyKey: `bad-config-${field}`,
          expectedVersion: taskCampaign.version,
          command: { ...valid, [field]: value },
        })
        expect(denied.ok).toBe(false)
        if (!denied.ok) expect(denied.code).toBe('invalid_cli_preparation_proposal')
      } finally {
        store.close()
      }
    }
  })

  test('does not issue a CLI approval without the exact proposed frozen specification', () => {
    const store = fresh()
    try {
      const campaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(campaign.taskRevisions[0]!.id)
      const denied = approveCliPreparation(store, campaign, proposal, 'missing-proposal')
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('invalid_approval_scope')
    } finally {
      store.close()
    }
  })

  test('does not let an approval substitute a different device-bound configuration hash', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-scope-hash',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const denied = approveCliPreparation(
        store,
        proposed.campaign,
        { ...proposal, configHash: CONTENT_HASH },
        'wrong-device-bound-hash',
      )
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('invalid_approval_scope')
    } finally {
      store.close()
    }
  })

  test('rejects claim after the proposed task becomes stale', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-stale',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const approved = approveCliPreparation(store, proposed.campaign, proposal, 'approve-stale')
      if (!approved.ok) throw new Error(approved.message)
      const changed = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'change-context',
        expectedVersion: approved.campaign.version,
        command: { kind: 'setInputs', inputs: { modality: 'fundus' } },
      })
      if (!changed.ok) throw new Error(changed.message)
      const denied = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'claim-stale',
        expectedVersion: changed.campaign.version,
        command: {
          kind: 'claimCliPreparation',
          preparationId: proposal.preparationId,
          approvalId: approved.campaign.approvals[0]!.id,
        },
      })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('cli_preparation_approval_required')
    } finally {
      store.close()
    }
  })

  test('rejects a CLI claim when an ordinary attempt already owns its dispatch key', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-collision',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const ordinary = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'ordinary-collision',
        expectedVersion: proposed.campaign.version,
        command: {
          kind: 'claimSynthetic',
          taskRevisionId: proposal.taskRevisionId,
          templateId: 'synthetic-summary-v1',
          dispatchKey: proposal.dispatchKey,
          inputHash: INPUT_HASH,
        },
      })
      if (!ordinary.ok) throw new Error(ordinary.message)
      const approved = approveCliPreparation(
        store,
        ordinary.campaign,
        proposal,
        'approve-collision',
      )
      if (!approved.ok) throw new Error(approved.message)
      const denied = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'claim-collision',
        expectedVersion: approved.campaign.version,
        command: {
          kind: 'claimCliPreparation',
          preparationId: proposal.preparationId,
          approvalId: approved.campaign.approvals[0]!.id,
        },
      })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('cli_preparation_approval_required')
    } finally {
      store.close()
    }
  })

  test('claims once under an exact approval and replays the original claim idempotently', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-claim',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const approved = approveCliPreparation(store, proposed.campaign, proposal, 'approve-claim')
      if (!approved.ok) throw new Error(approved.message)
      const command = {
        kind: 'claimCliPreparation' as const,
        preparationId: proposal.preparationId,
        approvalId: approved.campaign.approvals[0]!.id,
      }
      const claimed = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'claim-once',
        expectedVersion: approved.campaign.version,
        command,
      })
      if (!claimed.ok) throw new Error(claimed.message)
      expect(claimed.campaign.attempts).toHaveLength(1)
      const replayed = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'claim-once',
        expectedVersion: approved.campaign.version,
        command,
      })
      expect(replayed.ok && replayed.replayed).toBe(true)
      if (replayed.ok) expect(replayed.campaign.attempts).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('does not overcommit a CLI claim after an existing model reservation', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id, { maxCost: 60 })
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-after-review-reservation',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const approved = approveCliPreparation(
        store,
        proposed.campaign,
        proposal,
        'approve-after-review',
      )
      if (!approved.ok) throw new Error(approved.message)
      const reservedCampaign = {
        ...approved.campaign,
        modelReviews: [
          {
            id: 'rmr_existing',
            dispatchKey: 'review-existing',
            approvalId: 'hap-existing',
            evidencePackHash: CONTENT_HASH,
            configHash: CONTENT_HASH,
            artifactVersionIds: [],
            currency: 'USD',
            reservedCost: 50,
            maxRequests: 2,
            maxOutputTokens: 1024,
            requestCount: 0,
            status: 'reserved' as const,
            ownerPid: 1,
          },
        ],
      }
      store.db
        .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
        .run(JSON.stringify(reservedCampaign), reservedCampaign.id)
      const denied = mutateResearchCampaign(store, reservedCampaign.id, {
        idempotencyKey: 'claim-overcommitted',
        expectedVersion: reservedCampaign.version,
        command: {
          kind: 'claimCliPreparation',
          preparationId: proposal.preparationId,
          approvalId: approved.campaign.approvals[0]!.id,
        },
      })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.code).toBe('cli_preparation_approval_required')
    } finally {
      store.close()
    }
  })

  test('binds a v3 CLI job to its attempt and finishes only a candidate artifact', () => {
    const store = fresh()
    try {
      const taskCampaign = declareCliTask(store, created(store).campaign)
      const proposal = cliProposal(taskCampaign.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, taskCampaign.id, {
        idempotencyKey: 'propose-bind-finish',
        expectedVersion: taskCampaign.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const approved = approveCliPreparation(
        store,
        proposed.campaign,
        proposal,
        'approve-bind-finish',
      )
      if (!approved.ok) throw new Error(approved.message)
      const claimed = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'claim-bind-finish',
        expectedVersion: approved.campaign.version,
        command: {
          kind: 'claimCliPreparation',
          preparationId: proposal.preparationId,
          approvalId: approved.campaign.approvals[0]!.id,
        },
      })
      if (!claimed.ok) throw new Error(claimed.message)
      const preparation = claimed.campaign.cliPreparations![0]!
      const attempt = claimed.campaign.attempts[0]!
      const spec = cliPreparationJobSpec(claimed.campaign, preparation, attempt.id)
      const wrongDevice = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'bind-wrong-device',
        expectedVersion: claimed.campaign.version,
        command: {
          kind: 'bindCliPreparationJob',
          attemptId: attempt.id,
          spec: { ...spec, execution: { ...spec.execution, deviceId: 'other-device' } },
        },
      })
      expect(wrongDevice.ok).toBe(false)
      const unsafeLease = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'bind-unsafe-lease',
        expectedVersion: claimed.campaign.version,
        command: {
          kind: 'bindCliPreparationJob',
          attemptId: attempt.id,
          spec: {
            ...spec,
            lease: { ...spec.lease, ownerId: '', expiresAt: Date.now() + 10 * 60 * 1000 + 1 },
          },
        },
      })
      expect(unsafeLease.ok).toBe(false)
      const bound = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'bind-correct',
        expectedVersion: claimed.campaign.version,
        command: { kind: 'bindCliPreparationJob', attemptId: attempt.id, spec },
      })
      if (!bound.ok) throw new Error(bound.message)
      const boundAttempt = bound.campaign.attempts[0]!
      const specHash = sha256(canonicalJson(spec))
      expect(boundAttempt.cliPreparationJobSpecHash).toBe(specHash)
      const rebound = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'bind-correct',
        expectedVersion: claimed.campaign.version,
        command: { kind: 'bindCliPreparationJob', attemptId: attempt.id, spec },
      })
      expect(rebound.ok && rebound.replayed).toBe(true)
      // Imported historical ledgers can contain a revoked consumed approval
      // without the newer cancelRequestedAt marker. A normal finish must not
      // admit that receipt as a candidate.
      const historicallyRevoked = {
        ...bound.campaign,
        approvals: bound.campaign.approvals.map((approval) =>
          approval.consumedBy === attempt.id
            ? { ...approval, status: 'revoked' as const }
            : approval,
        ),
      }
      store.db
        .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
        .run(JSON.stringify(historicallyRevoked), historicallyRevoked.id)
      const revokedFinish = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'finish-revoked-candidate',
        expectedVersion: bound.campaign.version,
        command: {
          kind: 'finishCliPreparation',
          attemptId: attempt.id,
          uri: 'research/candidates/candidate.json',
          artifactKind: 'cli_preparation_candidate',
          contentHash: CONTENT_HASH,
          validation: {
            schema: 'research-cli-preparation-candidate-v1',
            jobSpecHash: specHash,
            dispatchKey: attempt.id,
            clientDispatchKey: preparation.dispatchKey,
            preparationId: preparation.id,
            candidateId: preparation.candidateId,
            taskRevisionId: preparation.taskRevisionId,
            inputHash: preparation.inputHash,
            configHash: preparation.configHash,
            contentHash: CONTENT_HASH,
            draftContentHash: `sha256:${'f'.repeat(64)}`,
            byteLength: 22,
            verifiedAt: Date.now(),
          },
        },
      })
      expect(revokedFinish.ok).toBe(false)
      if (!revokedFinish.ok) expect(revokedFinish.code).toBe('invalid_cli_preparation_finish')
      store.db
        .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
        .run(JSON.stringify(bound.campaign), bound.campaign.id)
      const finished = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'finish-candidate',
        expectedVersion: bound.campaign.version,
        command: {
          kind: 'finishCliPreparation',
          attemptId: attempt.id,
          uri: 'research/candidates/candidate.json',
          artifactKind: 'cli_preparation_candidate',
          contentHash: CONTENT_HASH,
          validation: {
            schema: 'research-cli-preparation-candidate-v1',
            jobSpecHash: specHash,
            dispatchKey: attempt.id,
            clientDispatchKey: preparation.dispatchKey,
            preparationId: preparation.id,
            candidateId: preparation.candidateId,
            taskRevisionId: preparation.taskRevisionId,
            inputHash: preparation.inputHash,
            configHash: preparation.configHash,
            contentHash: CONTENT_HASH,
            draftContentHash: `sha256:${'f'.repeat(64)}`,
            byteLength: 22,
            verifiedAt: Date.now(),
          },
        },
      })
      if (!finished.ok) throw new Error(finished.message)
      expect(finished.campaign.cliPreparations![0]).toMatchObject({
        status: 'candidate',
        actualCost: null,
      })
      expect(finished.campaign.artifactVersions[0]?.kind).toBe('cli_preparation_candidate')
      expect(finished.campaign.artifactVersions[0]?.producerTaskRevisionId).toBeUndefined()
      expect(finished.campaign.taskRevisions[0]!.status).toBe('pending')
      const lowerBudget = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'cannot-release-unknown-cli-reservation',
        expectedVersion: finished.campaign.version,
        command: { kind: 'setBudget', budget: { currency: 'USD', limit: 1 } },
      })
      expect(lowerBudget.ok).toBe(false)
      if (!lowerBudget.ok) expect(lowerBudget.code).toBe('reserved_budget')
      const changedCurrency = mutateResearchCampaign(store, proposed.campaign.id, {
        idempotencyKey: 'cannot-convert-unknown-cli-reservation',
        expectedVersion: finished.campaign.version,
        command: { kind: 'setBudget', budget: { currency: 'EUR', limit: 100 } },
      })
      expect(changedCurrency.ok).toBe(false)
      if (!changedCurrency.ok) expect(changedCurrency.code).toBe('reserved_budget')
    } finally {
      store.close()
    }
  })

  test('release requires a current exact supported claim-evidence map in addition to its signed approval', () => {
    const release = (review: Parameters<typeof installReleaseReview>[2], key: string) => {
      const store = fresh()
      const completed = completeReleaseArtifact(store)
      const artifactIds = completed.artifactVersions.map((item) => item.id)
      const reviewed = installReleaseReview(store, completed, review)
      const approved = approveRelease(store, reviewed, artifactIds)
      const result = mutateResearchCampaign(store, completed.id, {
        idempotencyKey: key,
        expectedVersion: approved.version,
        command: {
          kind: 'release',
          approvalId: approved.approvals.at(-1)!.id,
          artifactVersionIds: artifactIds,
        },
      })
      store.close()
      return result
    }

    const supported = release({}, 'release-supported')
    expect(supported).toMatchObject({ ok: true, campaign: { status: 'completed' } })

    const insufficient = release(
      {
        text: JSON.stringify({ decision: 'insufficient', claims: [], limitations: ['More data.'] }),
      },
      'release-insufficient',
    )
    expect(insufficient).toMatchObject({ ok: false, code: 'approval_required' })

    const refuted = release(
      { text: JSON.stringify({ decision: 'refuted', claims: [], limitations: ['Refuted.'] }) },
      'release-refuted',
    )
    expect(refuted).toMatchObject({ ok: false, code: 'approval_required' })

    const doneWithoutMap = release({ text: '' }, 'release-done-without-map')
    expect(doneWithoutMap).toMatchObject({ ok: false, code: 'approval_required' })

    const stale = release({ sourceContextHash: `sha256:${'f'.repeat(64)}` }, 'release-stale-review')
    expect(stale).toMatchObject({ ok: false, code: 'approval_required' })

    const differentArtifact = release(
      { artifactVersionIds: ['rav_different'] },
      'release-different-artifact',
    )
    expect(differentArtifact).toMatchObject({ ok: false, code: 'approval_required' })

    const differentClaim = release(
      {
        text: JSON.stringify({
          decision: 'supported',
          claims: [
            { claim: 'A different artifact is supported.', artifactVersionIds: ['rav_other'] },
          ],
          limitations: [],
        }),
      },
      'release-different-claim',
    )
    expect(differentClaim).toMatchObject({ ok: false, code: 'approval_required' })
  })

  test('release rejects an artifact that is not exactly bound to its verified task attempt', () => {
    const releaseWith = (
      rewrite: (campaign: ResearchCampaign) => ResearchCampaign,
      key: string,
    ) => {
      const store = fresh()
      const completed = completeReleaseArtifact(store)
      const artifactIds = completed.artifactVersions.map((item) => item.id)
      const reviewed = installReleaseReview(store, completed)
      const altered = replaceCampaignSnapshot(store, rewrite(reviewed))
      const approved = approveRelease(store, altered, artifactIds)
      const result = mutateResearchCampaign(store, altered.id, {
        idempotencyKey: key,
        expectedVersion: approved.version,
        command: {
          kind: 'release',
          approvalId: approved.approvals.at(-1)!.id,
          artifactVersionIds: artifactIds,
        },
      })
      store.close()
      return result
    }
    const updateArtifact = (
      campaign: ResearchCampaign,
      update: (
        artifact: ResearchCampaign['artifactVersions'][number],
      ) => ResearchCampaign['artifactVersions'][number],
    ) => ({
      ...campaign,
      artifactVersions: campaign.artifactVersions.map((artifact, index) =>
        index === 0 ? update(artifact) : artifact,
      ),
    })
    expect(
      releaseWith(
        (campaign) =>
          updateArtifact(campaign, (artifact) => ({
            ...artifact,
            contentHash: `sha256:${'f'.repeat(64)}`,
          })),
        'release-content-hash-mismatch',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
    expect(
      releaseWith(
        (campaign) =>
          updateArtifact(campaign, (artifact) => ({
            ...artifact,
            validation: { ...artifact.validation!, inputHash: `sha256:${'f'.repeat(64)}` },
          })),
        'release-input-hash-mismatch',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
    expect(
      releaseWith(
        (campaign) =>
          updateArtifact(campaign, (artifact) => ({ ...artifact, producerAttemptId: 'rat_other' })),
        'release-attempt-mismatch',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
    expect(
      releaseWith(
        (campaign) => ({
          ...campaign,
          attempts: campaign.attempts.map((attempt) => ({ ...attempt, artifactVersionId: null })),
        }),
        'release-attempt-artifact-mismatch',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
    expect(
      releaseWith(
        (campaign) =>
          updateArtifact(campaign, (artifact) => ({
            ...artifact,
            producerTaskRevisionId: 'rtr_other',
          })),
        'release-task-mismatch',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
    expect(
      releaseWith(
        (campaign) =>
          updateArtifact(campaign, (artifact) => ({
            ...artifact,
            kind: 'cli_preparation_candidate',
          })),
        'release-cli-candidate',
      ),
    ).toMatchObject({ ok: false, code: 'approval_required' })
  })

  test('persists manual progress holds with generation CAS while retaining legacy defaults', () => {
    const path = join('/tmp', `oph-research-progress-${crypto.randomUUID()}.sqlite`)
    let campaignId = ''
    const store = fresh(path)
    try {
      const campaign = created(store).campaign
      campaignId = campaign.id
      expect(
        getResearchCampaign(store, campaign.id)?.progressControl ?? {
          mode: 'manual',
          state: 'active',
          generation: 0,
        },
      ).toEqual({ mode: 'manual', state: 'active', generation: 0 })
      const held = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'hold',
        expectedVersion: campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      expect(held).toMatchObject({
        ok: true,
        campaign: { progressControl: { mode: 'manual', state: 'held', generation: 1 } },
      })
      const replay = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'hold',
        expectedVersion: campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      expect(replay).toMatchObject({ ok: true, replayed: true })
      const staleGeneration = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'stale-hold',
        expectedVersion: held.ok ? held.campaign.version : campaign.version,
        command: { kind: 'setResearchProgress', state: 'active', expectedGeneration: 0 },
      })
      expect(staleGeneration).toMatchObject({ ok: false, code: 'progress_generation_conflict' })
    } finally {
      store.close()
    }
    const reopened = fresh(path)
    try {
      expect(getResearchCampaign(reopened, campaignId)?.progressControl).toEqual({
        mode: 'manual',
        state: 'held',
        generation: 1,
      })
    } finally {
      reopened.close()
      rmSync(path, { force: true })
    }
  })

  test('a hold blocks new synthetic claims but keeps existing replay, finish, and unknown cancellation available', () => {
    const store = fresh()
    try {
      const campaign = created(store).campaign
      const claimed = claim(store, campaign.id, campaign.version, 'held-existing')
      if (!claimed.ok) throw new Error(claimed.message)
      const held = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'hold-existing',
        expectedVersion: claimed.campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      if (!held.ok) throw new Error(held.message)
      const replay = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'replay-existing-after-hold',
        expectedVersion: held.campaign.version,
        command: { kind: 'claimSynthetic', dispatchKey: 'held-existing', inputHash: INPUT_HASH },
      })
      expect(replay).toMatchObject({ ok: true, replayed: true })
      const blocked = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'claim-new-after-hold',
        expectedVersion: held.campaign.version,
        command: { kind: 'claimSynthetic', dispatchKey: 'held-new', inputHash: INPUT_HASH },
      })
      expect(blocked).toMatchObject({ ok: false, code: 'progress_held' })
      const finished = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'finish-existing-after-hold',
        expectedVersion: held.campaign.version,
        command: {
          kind: 'finishSynthetic',
          attemptId: claimed.campaign.attempts[0]!.id,
          uri: 'research/held-existing.json',
          artifactKind: 'synthetic-summary-v1',
          contentHash: CONTENT_HASH,
          validation: {
            inputHash: INPUT_HASH,
            contentHash: CONTENT_HASH,
            byteLength: 1,
            verifiedAt: Date.now(),
          },
        },
      })
      expect(finished).toMatchObject({ ok: true, campaign: { progressControl: { state: 'held' } } })
    } finally {
      store.close()
    }

    const unknownStore = fresh()
    try {
      const campaign = created(unknownStore).campaign
      const claimed = mutateResearchCampaign(unknownStore, campaign.id, {
        idempotencyKey: 'claim-unknown-before-hold',
        expectedVersion: campaign.version,
        command: {
          kind: 'claimSynthetic',
          dispatchKey: 'held-unknown',
          inputHash: INPUT_HASH,
          backend: 'localhost-daemon',
        },
      })
      if (!claimed.ok) throw new Error(claimed.message)
      const held = mutateResearchCampaign(unknownStore, campaign.id, {
        idempotencyKey: 'hold-unknown',
        expectedVersion: claimed.campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      if (!held.ok) throw new Error(held.message)
      const unknown = mutateResearchCampaign(unknownStore, campaign.id, {
        idempotencyKey: 'mark-unknown-after-hold',
        expectedVersion: held.campaign.version,
        command: {
          kind: 'markSyntheticUnknown',
          attemptId: claimed.campaign.attempts[0]!.id,
          reason: 'lost',
        },
      })
      if (!unknown.ok) throw new Error(unknown.message)
      const cancelled = mutateResearchCampaign(unknownStore, campaign.id, {
        idempotencyKey: 'cancel-unknown-after-hold',
        expectedVersion: unknown.campaign.version,
        command: { kind: 'requestCancelSynthetic', attemptId: claimed.campaign.attempts[0]!.id },
      })
      expect(cancelled).toMatchObject({
        ok: true,
        campaign: { attempts: [{ cancelRequestedAt: expect.any(Number) }] },
      })
    } finally {
      unknownStore.close()
    }
  })

  test('a hold blocks new CLI preparation claims and model-review reservations', () => {
    const store = fresh()
    try {
      const initial = created(store).campaign
      const declared = declareCliTask(store, initial)
      const proposal = cliProposal(declared.taskRevisions[0]!.id)
      const proposed = mutateResearchCampaign(store, declared.id, {
        idempotencyKey: 'propose-held-cli',
        expectedVersion: declared.version,
        command: proposal,
      })
      if (!proposed.ok) throw new Error(proposed.message)
      const approved = approveCliPreparation(store, proposed.campaign, proposal, 'approve-held-cli')
      if (!approved.ok) throw new Error(approved.message)
      const held = mutateResearchCampaign(store, initial.id, {
        idempotencyKey: 'hold-cli',
        expectedVersion: approved.campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      if (!held.ok) throw new Error(held.message)
      const denied = mutateResearchCampaign(store, initial.id, {
        idempotencyKey: 'claim-held-cli',
        expectedVersion: held.campaign.version,
        command: {
          kind: 'claimCliPreparation',
          preparationId: proposal.preparationId,
          approvalId: approved.campaign.approvals[0]!.id,
        },
      })
      expect(denied).toMatchObject({ ok: false, code: 'progress_held' })
    } finally {
      store.close()
    }

    const reviewStore = fresh()
    try {
      const completed = completeReleaseArtifact(reviewStore)
      const artifactVersionIds = completed.artifactVersions.map((artifact) => artifact.id)
      const scope = {
        kind: 'model_review' as const,
        dispatchKey: 'held-review',
        evidencePackHash: `sha256:${'d'.repeat(64)}`,
        configHash: `sha256:${'e'.repeat(64)}`,
        maxRequests: 2,
        maxOutputTokens: 1024,
        artifactVersionIds,
        currency: completed.budget.currency,
        maxCost: 1,
        expiresAt: Date.now() + 60_000,
      }
      const approved = mutateResearchCampaign(reviewStore, completed.id, {
        idempotencyKey: 'approve-held-review',
        expectedVersion: completed.version,
        command: {
          kind: 'approve',
          bundleHash: completed.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'held-review-proof', verifiedAt: Date.now() },
          scope,
        },
      })
      if (!approved.ok) throw new Error(approved.message)
      const held = mutateResearchCampaign(reviewStore, completed.id, {
        idempotencyKey: 'hold-review',
        expectedVersion: approved.campaign.version,
        command: { kind: 'setResearchProgress', state: 'held', expectedGeneration: 0 },
      })
      if (!held.ok) throw new Error(held.message)
      const denied = mutateResearchCampaign(reviewStore, completed.id, {
        idempotencyKey: 'reserve-held-review',
        expectedVersion: held.campaign.version,
        command: {
          kind: 'reserveModelReview',
          spec: {
            dispatchKey: scope.dispatchKey,
            approvalId: approved.campaign.approvals[0]!.id,
            evidencePackHash: scope.evidencePackHash,
            configHash: scope.configHash,
            artifactVersionIds,
            currency: scope.currency,
            reservedCost: 1,
            maxRequests: 2,
            maxOutputTokens: 1024,
          },
        },
      })
      expect(denied).toMatchObject({ ok: false, code: 'progress_held' })
    } finally {
      reviewStore.close()
    }
  })

  test('cost evidence settles only under an exact human approval and retains conservative occupancy', () => {
    const store = fresh()
    try {
      const initial = created(store).campaign
      const campaign = replaceCampaignSnapshot(store, {
        ...initial,
        modelReviews: [
          {
            id: 'rmr_cost',
            dispatchKey: 'cost-review',
            approvalId: 'hap-review',
            evidencePackHash: `sha256:${'d'.repeat(64)}`,
            configHash: `sha256:${'e'.repeat(64)}`,
            artifactVersionIds: [],
            currency: 'USD',
            reservedCost: 10,
            maxRequests: 2,
            maxOutputTokens: 1024,
            requestCount: 1,
            status: 'failed',
            ownerPid: process.pid,
            actualCost: null,
          },
        ],
      })
      expect(researchCostSummary(campaign).subjects[0]).toMatchObject({
        knownActualCost: null,
        knownActualSource: null,
      })
      const wrongCurrency = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'cost-eur',
        expectedVersion: campaign.version,
        command: {
          kind: 'recordCostEvidence',
          evidence: {
            id: 'rce-eur',
            subject: { kind: 'model_review', id: 'rmr_cost' },
            currency: 'EUR',
            amount: 20,
            description: 'Recorded provider cost in the wrong currency.',
            sourceHash: CONTENT_HASH,
            source: 'provider-receipt',
          },
        },
      })
      expect(wrongCurrency).toMatchObject({ ok: false, code: 'invalid_cost_evidence' })
      const recorded = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'cost-provider',
        expectedVersion: campaign.version,
        command: {
          kind: 'recordCostEvidence',
          evidence: {
            id: 'rce-provider',
            subject: { kind: 'model_review', id: 'rmr_cost' },
            currency: 'USD',
            amount: 20,
            description: 'Provider receipt reports the completed independent review cost.',
            sourceHash: CONTENT_HASH,
            source: 'provider-receipt',
          },
        },
      })
      if (!recorded.ok) throw new Error(recorded.message)
      expect(researchCostSummary(recorded.campaign).subjects[0]).toMatchObject({
        knownActualCost: 20,
        knownActualSource: 'provider-receipt',
      })
      const lowerBudget = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'cost-overrun-budget',
        expectedVersion: recorded.campaign.version,
        command: { kind: 'setBudget', budget: { currency: 'USD', limit: 15 } },
      })
      expect(lowerBudget).toMatchObject({ ok: false, code: 'reserved_budget' })
      const changedCurrency = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'cost-currency-budget',
        expectedVersion: recorded.campaign.version,
        command: { kind: 'setBudget', budget: { currency: 'EUR', limit: 100 } },
      })
      expect(changedCurrency).toMatchObject({ ok: false, code: 'reserved_budget' })
      const scope = costEvidenceApprovalScope(
        recorded.campaign,
        'rce-provider',
        Date.now() + 60_000,
      )
      const approved = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-cost',
        expectedVersion: recorded.campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-cost',
          bundleHash: recorded.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'cost-proof-1', verifiedAt: Date.now() },
          scope,
        },
      })
      if (!approved.ok) throw new Error(approved.message)
      const differentProofReplay = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-cost',
        expectedVersion: recorded.campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-cost',
          bundleHash: recorded.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'cost-proof-2', verifiedAt: Date.now() },
          scope,
        },
      })
      expect(differentProofReplay).toMatchObject({ ok: false, code: 'idempotency_conflict' })
      const settled = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'settle-cost',
        expectedVersion: approved.campaign.version,
        command: { kind: 'settleCostEvidence', evidenceId: 'rce-provider', approvalId: 'hap-cost' },
      })
      expect(settled).toMatchObject({
        ok: true,
        campaign: { costSettlements: [{ amount: 20, evidenceId: 'rce-provider' }] },
      })
      if (!settled.ok) return
      const secondEvidence = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'cost-second-evidence',
        expectedVersion: settled.campaign.version,
        command: {
          kind: 'recordCostEvidence',
          evidence: {
            id: 'rce-second',
            subject: { kind: 'model_review', id: 'rmr_cost' },
            currency: 'USD',
            amount: 21,
            description: 'A later human attestation for the same finished review.',
            sourceHash: `sha256:${'f'.repeat(64)}`,
            source: 'human-attestation',
          },
        },
      })
      if (!secondEvidence.ok) throw new Error(secondEvidence.message)
      expect(researchCostSummary(secondEvidence.campaign)).toMatchObject({
        settledCost: 20,
        committedCost: 21,
      })
      const lateOverrun = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'late-settled-overrun',
        expectedVersion: secondEvidence.campaign.version,
        command: { kind: 'setBudget', budget: { currency: 'USD', limit: 20 } },
      })
      expect(lateOverrun).toMatchObject({ ok: false, code: 'reserved_budget' })
      const duplicateSubjectApproval = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-second-cost',
        expectedVersion: secondEvidence.campaign.version,
        command: {
          kind: 'approve',
          bundleHash: secondEvidence.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'cost-proof-3', verifiedAt: Date.now() },
          scope: costEvidenceApprovalScope(
            secondEvidence.campaign,
            'rce-second',
            Date.now() + 60_000,
          ),
        },
      })
      expect(duplicateSubjectApproval).toMatchObject({ ok: false, code: 'invalid_approval_scope' })
      const tamperedScope = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-tampered-cost',
        expectedVersion: secondEvidence.campaign.version,
        command: {
          kind: 'approve',
          bundleHash: secondEvidence.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'cost-proof-4', verifiedAt: Date.now() },
          scope: {
            ...costEvidenceApprovalScope(
              secondEvidence.campaign,
              'rce-second',
              Date.now() + 60_000,
            ),
            costAmount: 20,
            maxCost: 20,
          },
        },
      })
      expect(tamperedScope).toMatchObject({ ok: false, code: 'invalid_approval_scope' })
      const misleadingLabel = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-misleading-label',
        expectedVersion: secondEvidence.campaign.version,
        command: {
          kind: 'approve',
          bundleHash: secondEvidence.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'cost-proof-5', verifiedAt: Date.now() },
          scope: {
            ...costEvidenceApprovalScope(
              secondEvidence.campaign,
              'rce-second',
              Date.now() + 60_000,
            ),
            costSubjectLabel: '第 99 次独立复核',
          },
        },
      })
      expect(misleadingLabel).toMatchObject({ ok: false, code: 'invalid_approval_scope' })
    } finally {
      store.close()
    }
  })

  test('v2 scientific context ignores budget changes while legacy v1 remains budget-bound', () => {
    const store = fresh()
    try {
      const v2 = completeReleaseArtifact(store)
      expect(v2.taskRevisions[0]).toMatchObject({ sourceContextVersion: 2 })
      const raised = mutateResearchCampaign(store, v2.id, {
        idempotencyKey: 'raise-v2-budget',
        expectedVersion: v2.version,
        command: { kind: 'setBudget', budget: { currency: 'USD', limit: 101 } },
      })
      expect(raised).toMatchObject({ ok: true })
      if (!raised.ok) return
      expect(raised.campaign.taskRevisions[0]).toMatchObject({ status: 'verified' })

      const legacy = replaceCampaignSnapshot(store, {
        ...raised.campaign,
        taskRevisions: raised.campaign.taskRevisions.map(
          ({ sourceContextVersion: _version, ...task }) => ({
            ...task,
            sourceContextHash: scientificContextHash(raised.campaign, 1),
          }),
        ),
      })
      const changed = mutateResearchCampaign(store, legacy.id, {
        idempotencyKey: 'raise-v1-budget',
        expectedVersion: legacy.version,
        command: { kind: 'setBudget', budget: { currency: 'USD', limit: 102 } },
      })
      expect(changed).toMatchObject({ ok: true })
      if (changed.ok) expect(changed.campaign.taskRevisions[0]).toMatchObject({ status: 'stale' })
    } finally {
      store.close()
    }
  })

  test('cost settlement retains reservations until the bound execution has a terminal fact', () => {
    const store = fresh()
    try {
      const initial = created(store).campaign
      const running = replaceCampaignSnapshot(store, {
        ...initial,
        modelReviews: [
          {
            id: 'rmr_running_cost',
            dispatchKey: 'running-cost-review',
            approvalId: 'hap-running-review',
            evidencePackHash: `sha256:${'d'.repeat(64)}`,
            configHash: `sha256:${'e'.repeat(64)}`,
            artifactVersionIds: [],
            currency: 'USD',
            reservedCost: 10,
            maxRequests: 2,
            maxOutputTokens: 1024,
            requestCount: 1,
            status: 'running',
            ownerPid: process.pid,
          },
        ],
      })
      const evidence = mutateResearchCampaign(store, running.id, {
        idempotencyKey: 'record-running-cost',
        expectedVersion: running.version,
        command: {
          kind: 'recordCostEvidence',
          evidence: {
            id: 'rce-running',
            subject: { kind: 'model_review', id: 'rmr_running_cost' },
            currency: 'USD',
            amount: 10,
            description: 'A partial provider receipt while the review remains active.',
            sourceHash: CONTENT_HASH,
            source: 'provider-receipt',
          },
        },
      })
      if (!evidence.ok) throw new Error(evidence.message)
      expect(() =>
        costEvidenceApprovalScope(evidence.campaign, 'rce-running', Date.now() + 60_000),
      ).toThrow('not terminal')
    } finally {
      store.close()
    }
  })

  test('bounded controller persists its approval, request, advance, and terminal counters', () => {
    const store = fresh()
    try {
      const campaign = created(store).campaign
      const limits = {
        maxAdvances: 1,
        maxModelRequests: 1,
        maxOutputTokens: 10,
        maxInputCharacters: 10,
        deadlineAt: Date.now() + 60_000,
        stopAfter: 'candidate' as const,
      }
      const scope = controllerApprovalScope(campaign, {
        configHash: CONTENT_HASH,
        reservedCost: 5,
        limits,
        expiresAt: Date.now() + 60_000,
      })
      const approved = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-controller',
        expectedVersion: campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-controller',
          bundleHash: campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'controller-proof', verifiedAt: Date.now() },
          scope,
        },
      })
      if (!approved.ok) throw new Error(approved.message)
      const active = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'activate-controller',
        expectedVersion: approved.campaign.version,
        command: {
          kind: 'activateBoundedResearch',
          reservationId: 'rcr_1',
          approvalId: 'hap-controller',
          configHash: CONTENT_HASH,
          currency: 'USD',
          reservedCost: 5,
          limits,
          expectedGeneration: 0,
        },
      })
      if (!active.ok) throw new Error(active.message)
      const revoked = replaceCampaignSnapshot(store, {
        ...active.campaign,
        approvals: active.campaign.approvals.map((approval) =>
          approval.id === 'hap-controller' ? { ...approval, status: 'revoked' as const } : approval,
        ),
      })
      expect(canStartControllerRequest(revoked, 'rcr_1', 1)).toBe(false)
      expect(
        mutateResearchCampaign(store, campaign.id, {
          idempotencyKey: 'start-revoked-controller',
          expectedVersion: revoked.version,
          command: {
            kind: 'startControllerRequest',
            reservationId: 'rcr_1',
            requestId: 'revoked_request',
            generation: 1,
          },
        }),
      ).toMatchObject({ ok: false, code: 'controller_request_denied' })
      replaceCampaignSnapshot(store, active.campaign)
      expect(canStartControllerRequest(active.campaign, 'rcr_1', 1)).toBe(true)
      const unknownAttempt = replaceCampaignSnapshot(store, {
        ...active.campaign,
        attempts: [
          ...active.campaign.attempts,
          {
            id: 'unknown-controller-admission',
            taskRevisionId: 'controller-unrelated-task',
            dispatchKey: 'unknown-controller-admission',
            ownerPid: process.pid,
            status: 'unknown',
            executionStartedAt: Date.now(),
            endedAt: null,
            artifactVersionId: null,
            error: null,
            cancelRequestedAt: null,
          },
        ],
      })
      expect(canStartControllerRequest(unknownAttempt, 'rcr_1', 1)).toBe(false)
      expect(
        mutateResearchCampaign(store, campaign.id, {
          idempotencyKey: 'advance-unknown-controller',
          expectedVersion: unknownAttempt.version,
          command: {
            kind: 'reserveControllerAdvance',
            reservationId: 'rcr_1',
            generation: 1,
            actionKey: 'advance-unknown',
          },
        }),
      ).toMatchObject({ ok: false, code: 'controller_advance_denied' })
      replaceCampaignSnapshot(store, active.campaign)
      const started = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'start-controller',
        expectedVersion: active.campaign.version,
        command: {
          kind: 'startControllerRequest',
          reservationId: 'rcr_1',
          requestId: 'request_1',
          generation: 1,
        },
      })
      if (!started.ok) throw new Error(started.message)
      expect(canStartControllerRequest(started.campaign, 'rcr_1', 1)).toBe(false)
      const replayDenied = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'start-controller-again',
        expectedVersion: started.campaign.version,
        command: {
          kind: 'startControllerRequest',
          reservationId: 'rcr_1',
          requestId: 'request_1',
          generation: 1,
        },
      })
      expect(replayDenied).toMatchObject({ ok: false, code: 'controller_request_denied' })
      const concurrentDenied = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'start-controller-concurrent',
        expectedVersion: started.campaign.version,
        command: {
          kind: 'startControllerRequest',
          reservationId: 'rcr_1',
          requestId: 'request_2',
          generation: 1,
        },
      })
      expect(concurrentDenied).toMatchObject({ ok: false, code: 'controller_request_denied' })
      const advanced = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'advance-controller',
        expectedVersion: started.campaign.version,
        command: {
          kind: 'reserveControllerAdvance',
          reservationId: 'rcr_1',
          generation: 1,
          actionKey: 'advance_1',
        },
      })
      if (!advanced.ok) throw new Error(advanced.message)
      const finished = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'finish-controller',
        expectedVersion: advanced.campaign.version,
        command: {
          kind: 'finishControllerRequest',
          reservationId: 'rcr_1',
          requestId: 'request_1',
          actualCost: null,
          completed: false,
        },
      })
      expect(finished).toMatchObject({
        ok: true,
        campaign: { controllerReservations: [{ status: 'exhausted', actualCost: null }] },
      })
      if (!finished.ok) return
      const completed = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'complete-controller',
        expectedVersion: finished.campaign.version,
        command: { kind: 'completeBoundedResearch', reservationId: 'rcr_1', generation: 2 },
      })
      expect(completed).toMatchObject({ ok: false, code: 'controller_complete_denied' })
    } finally {
      store.close()
    }
  })

  test('bounded controller rejects expired or excessive approvals and permits a fresh approval only after the old reservation resolves', () => {
    const store = fresh()
    try {
      const campaign = created(store).campaign
      const limits = {
        maxAdvances: 1,
        maxModelRequests: 1,
        maxOutputTokens: 10,
        maxInputCharacters: 10,
        deadlineAt: Date.now() + 60_000,
        stopAfter: 'candidate' as const,
      }
      const excessive = controllerApprovalScope(campaign, {
        configHash: CONTENT_HASH,
        reservedCost: 5,
        limits: { ...limits, maxModelRequests: 51 },
        expiresAt: Date.now() + 60_000,
      })
      const excessiveApproval = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-excessive-controller',
        expectedVersion: campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-excessive-controller',
          bundleHash: campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'excessive-proof', verifiedAt: Date.now() },
          scope: excessive,
        },
      })
      expect(excessiveApproval).toMatchObject({ ok: false, code: 'invalid_approval_scope' })

      const scope = controllerApprovalScope(campaign, {
        configHash: CONTENT_HASH,
        reservedCost: 5,
        limits,
        expiresAt: Date.now() + 60_000,
      })
      const approved = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-first-controller',
        expectedVersion: campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-first-controller',
          bundleHash: campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'first-proof', verifiedAt: Date.now() },
          scope,
        },
      })
      if (!approved.ok) throw new Error(approved.message)
      const expiredApproval = replaceCampaignSnapshot(store, {
        ...approved.campaign,
        approvals: approved.campaign.approvals.map((approval) =>
          approval.id === 'hap-first-controller'
            ? { ...approval, scope: { ...approval.scope!, expiresAt: Date.now() - 1 } }
            : approval,
        ),
      })
      expect(
        mutateResearchCampaign(store, campaign.id, {
          idempotencyKey: 'activate-expired-controller',
          expectedVersion: expiredApproval.version,
          command: {
            kind: 'activateBoundedResearch',
            reservationId: 'rcr_expired',
            approvalId: 'hap-first-controller',
            configHash: CONTENT_HASH,
            currency: 'USD',
            reservedCost: 5,
            limits,
            expectedGeneration: 0,
          },
        }),
      ).toMatchObject({ ok: false, code: 'controller_approval_required' })
      replaceCampaignSnapshot(store, approved.campaign)
      const active = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'activate-first-controller',
        expectedVersion: approved.campaign.version,
        command: {
          kind: 'activateBoundedResearch',
          reservationId: 'rcr_first',
          approvalId: 'hap-first-controller',
          configHash: CONTENT_HASH,
          currency: 'USD',
          reservedCost: 5,
          limits,
          expectedGeneration: 0,
        },
      })
      if (!active.ok) throw new Error(active.message)
      const started = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'start-first-controller',
        expectedVersion: active.campaign.version,
        command: {
          kind: 'startControllerRequest',
          reservationId: 'rcr_first',
          requestId: 'request_first',
          generation: 1,
        },
      })
      if (!started.ok) throw new Error(started.message)
      const finished = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'finish-first-controller',
        expectedVersion: started.campaign.version,
        command: {
          kind: 'finishControllerRequest',
          reservationId: 'rcr_first',
          requestId: 'request_first',
          actualCost: 1,
          completed: true,
        },
      })
      if (!finished.ok) throw new Error(finished.message)
      const completed = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'complete-first-controller',
        expectedVersion: finished.campaign.version,
        command: { kind: 'completeBoundedResearch', reservationId: 'rcr_first', generation: 2 },
      })
      if (!completed.ok) throw new Error(completed.message)

      const nextScope = controllerApprovalScope(completed.campaign, {
        configHash: `sha256:${'b'.repeat(64)}`,
        reservedCost: 5,
        limits: { ...limits, deadlineAt: Date.now() + 60_000 },
        expiresAt: Date.now() + 60_000,
      })
      const secondApproved = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'approve-second-controller',
        expectedVersion: completed.campaign.version,
        command: {
          kind: 'approve',
          approvalId: 'hap-second-controller',
          bundleHash: completed.campaign.bundleHash,
          reviewer: { reviewerId: 'human', proofId: 'second-proof', verifiedAt: Date.now() },
          scope: nextScope,
        },
      })
      if (!secondApproved.ok) throw new Error(secondApproved.message)
      const secondActive = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'activate-second-controller',
        expectedVersion: secondApproved.campaign.version,
        command: {
          kind: 'activateBoundedResearch',
          reservationId: 'rcr_second',
          approvalId: 'hap-second-controller',
          configHash: `sha256:${'b'.repeat(64)}`,
          currency: 'USD',
          reservedCost: 5,
          limits: nextScope.controllerLimits!,
          expectedGeneration: 3,
        },
      })
      expect(secondActive).toMatchObject({
        ok: true,
        campaign: { controllerReservations: [{ id: 'rcr_first' }, { id: 'rcr_second' }] },
      })
    } finally {
      store.close()
    }
  })

  test('partial controller request costs remain committed before the aggregate is known', () => {
    const store = fresh()
    try {
      const campaign = created(store).campaign
      const snapshot = replaceCampaignSnapshot(store, {
        ...campaign,
        budget: { currency: 'USD', limit: 7 },
        controllerReservations: [
          {
            id: 'rcr_partial',
            sourceContextHash: scientificContextHash(campaign, 2),
            approvalId: 'hap_partial',
            configHash: CONTENT_HASH,
            currency: 'USD',
            reservedCost: 5,
            limits: {
              maxAdvances: 2,
              maxModelRequests: 2,
              maxOutputTokens: 10,
              maxInputCharacters: 10,
              deadlineAt: Date.now() + 60_000,
              stopAfter: 'candidate',
            },
            requests: [
              {
                id: 'known',
                startedAt: Date.now() - 2,
                finishedAt: Date.now() - 1,
                status: 'done',
                actualCost: 8,
              },
              { id: 'unpriced', startedAt: Date.now(), status: 'sending', actualCost: null },
            ],
            advancesUsed: 0,
            advanceKeys: [],
            status: 'active',
            actualCost: null,
            createdAt: Date.now() - 2,
          },
        ],
      })
      expect(researchCostSummary(snapshot)).toMatchObject({
        committedCost: 8,
        overLimit: true,
        subjects: [{ knownActualCost: 8 }],
      })
    } finally {
      store.close()
    }
  })
})
