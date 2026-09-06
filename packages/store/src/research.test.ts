/** Coverage: research.ts campaign event writes, projections, approvals, and idempotent recovery. */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Store } from './db.ts'
import { createConversation, upsertWorkspace } from './repos.ts'
import {
  createResearchCampaign,
  findRunningSyntheticAttempts,
  getResearchCampaign,
  listResearchCampaigns,
  listResearchEvents,
  mutateResearchCampaign,
  rebuildResearchCampaignProjection,
  recoverRunningSyntheticAttempts,
} from './research.ts'

const CONTENT_HASH = `sha256:${'a'.repeat(64)}`
const INPUT_HASH = `sha256:${'c'.repeat(64)}`

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
