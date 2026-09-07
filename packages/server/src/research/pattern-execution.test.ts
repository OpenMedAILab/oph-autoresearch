import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  listResearchEvents,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { handleResearchApi } from '../api/research.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { EventBus } from '../bus.ts'
import {
  advanceResearchPattern,
  applyResearchPattern,
  researchPatternStatus,
} from './pattern-execution.ts'
import { installSupportedReviewFixture } from './supported-review.fixture.ts'
import { startSyntheticRun } from './synthetic-runner.ts'

test('a new Pattern reopens a released campaign without erasing the prior release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-pattern-release-'))
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, root, 'released-pattern')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'fixture',
      model: 'fixture',
    })
    const created = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'Synthetic release and replan',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'create',
    })
    if (!created.ok) throw new Error(created.message)
    const run = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: created.campaign.id,
      expectedVersion: 1,
      dispatchKey: 'run',
    })
    if (!run.ok) throw new Error(run.error)
    const campaign = installSupportedReviewFixture(
      store,
      getResearchCampaign(store, created.campaign.id)!,
    )
    const ids = campaign.artifactVersions.map((a) => a.id)
    const approval = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: campaign.version,
      idempotencyKey: 'approve',
      command: {
        kind: 'approve',
        bundleHash: campaign.bundleHash,
        reviewer: {
          reviewerId: 'test-channel',
          proofId: crypto.randomUUID(),
          verifiedAt: Date.now(),
        },
        scope: {
          kind: 'release',
          artifactVersionIds: ids,
          currency: 'USD',
          maxCost: 0,
          expiresAt: Date.now() + 60_000,
        },
      },
    })
    if (!approval.ok) throw new Error(approval.message)
    const released = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: approval.campaign.version,
      idempotencyKey: 'release',
      command: {
        kind: 'release',
        approvalId: approval.campaign.approvals.at(-1)!.id,
        artifactVersionIds: ids,
      },
    })
    if (!released.ok) throw new Error(released.message)
    expect(released.campaign.status).toBe('completed')
    const before = listResearchEvents(store, campaign.id)
    const applied = applyResearchPattern({
      store,
      campaignId: campaign.id,
      expectedVersion: released.campaign.version,
      idempotencyKey: 'blocked',
      pattern: {
        dataMode: 'auto',
        backend: 'builtin-local',
        policy: {
          syntheticOnly: true,
          allowPublicMetadata: false,
          maxModelRequests: 2,
          currency: 'USD',
          budget: 0,
        },
        adaptive: { minSensitivity: 1, minSpecificity: 1, maxAuRocCIWidth: 0 },
      },
    })
    if (!applied.ok) throw new Error(applied.message)
    expect(applied.campaign.status).toBe('blocked')
    expect(applied.campaign.stage).toBe('protocol')
    expect(
      researchPatternStatus(applied.campaign).stages.find((s) => s.stageId === 'release')?.status,
    ).toBe('pending')
    expect(listResearchEvents(store, campaign.id).slice(0, before.length)).toEqual(before)
    expect(applied.campaign.artifactVersions).toEqual(released.campaign.artifactVersions)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unmet multi-candidate criteria persist without execution and remain historical after replanning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-pattern-blocked-'))
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, root, 'blocked-pattern')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'fixture',
      model: 'fixture',
    })
    const created = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'Synthetic strategy criteria',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'create',
    })
    if (!created.ok) throw new Error(created.message)
    const pattern = {
      dataMode: 'auto',
      backend: 'builtin-local',
      policy: {
        syntheticOnly: true,
        allowPublicMetadata: false,
        maxModelRequests: 2,
        currency: 'USD',
        budget: 0,
      },
      adaptive: { minSensitivity: 1, minSpecificity: 1, maxAuRocCIWidth: 0 },
    }
    const input = {
      store,
      campaignId: created.campaign.id,
      expectedVersion: 1,
      idempotencyKey: 'blocked',
      pattern,
    }
    const applied = applyResearchPattern(input)
    if (!applied.ok) throw new Error(applied.message)
    const current = getResearchCampaign(store, created.campaign.id)!
    expect(current.pattern?.taskRevisionIds).toEqual([])
    expect(current.taskRevisions).toHaveLength(0)
    expect(current.attempts).toHaveLength(0)
    const state = researchPatternStatus(current)
    expect(state.nextAction).toBe('replan-required')
    expect(state.adaptive).toMatchObject({ status: 'blocked', selectedTemplateId: null })
    const selection = current.pattern!.plan.selection as { measurements: unknown[] }
    expect(selection.measurements).toHaveLength(3)
    expect(listResearchEvents(store, current.id)).toHaveLength(2)
    expect(applyResearchPattern(input)).toMatchObject({ ok: true, replayed: true })
    expect(listResearchEvents(store, current.id)).toHaveLength(2)
    await expect(
      advanceResearchPattern({
        store,
        campaignId: current.id,
        workspaceRoot: root,
        expectedVersion: current.version,
      }),
    ).rejects.toThrow('No fixed execution')
    const bypass = mutateResearchCampaign(store, current.id, {
      expectedVersion: current.version,
      idempotencyKey: 'bypass',
      command: {
        kind: 'claimSynthetic',
        dispatchKey: 'bypass',
        inputHash: `sha256:${'a'.repeat(64)}`,
      },
    })
    expect(bypass).toMatchObject({ ok: false, code: 'pattern_task_required' })
    const release = mutateResearchCampaign(store, current.id, {
      expectedVersion: current.version,
      idempotencyKey: 'invalid-release',
      command: { kind: 'release', approvalId: 'not-approved', artifactVersionIds: [] },
    })
    expect(release).toMatchObject({ ok: false, code: 'pattern_review_required' })
    const accepted = applyResearchPattern({
      ...input,
      expectedVersion: current.version,
      idempotencyKey: 'passing',
      pattern: {
        ...pattern,
        adaptive: { minSensitivity: 0.5, minSpecificity: 0.5, maxAuRocCIWidth: 1 },
      },
    })
    if (!accepted.ok) throw new Error(accepted.message)
    expect(accepted.campaign.pattern?.taskRevisionIds).toHaveLength(2)
    expect(accepted.campaign.patternHistory).toEqual([current.pattern!])
    expect(researchPatternStatus(accepted.campaign).adaptive).toMatchObject({
      selectedTemplateId: 'synthetic-evaluation-v1',
      status: 'selected',
    })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTP Pattern compiles to one atomic ledger event and two approval-gated real Runner steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-pattern-'))
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, root, 'pattern')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const created = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'Fixed synthetic evaluation',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'create',
    })
    if (!created.ok) throw new Error(created.message)
    const id = created.campaign.id
    const deps = {
      store,
      workspaceId: workspace.id,
      workspaceRoot: root,
      bus: new EventBus(),
    } as unknown as ApiRequestDeps
    const pattern = {
      dataMode: 'features',
      backend: 'builtin-local',
      policy: {
        syntheticOnly: true,
        allowPublicMetadata: false,
        maxModelRequests: 2,
        currency: 'USD',
        budget: 0,
      },
      adaptive: { minSensitivity: 0.5, minSpecificity: 0.5, maxAuRocCIWidth: 1 },
    }
    const url = new URL(`http://localhost/api/research/campaigns/${id}/pattern`)
    const body = { pattern, expectedVersion: 1, idempotencyKey: 'apply' }
    const response = await handleResearchApi(
      url,
      new Request(url.toString(), { method: 'POST', body: JSON.stringify(body) }),
      deps,
    )
    expect(response?.status).toBe(200)
    const applied = getResearchCampaign(store, id)!
    expect(applied.version).toBe(2)
    expect(applied.pattern?.taskRevisionIds).toHaveLength(2)
    expect(applied.pattern?.plan.candidateAssessments).toHaveLength(3)
    let metadataCalls = 0
    const literatureUrl = new URL(`${url.origin}/api/research/campaigns/${id}/literature`)
    const metadataResponse = await handleResearchApi(
      literatureUrl,
      new Request(literatureUrl.toString(), {
        method: 'POST',
        body: JSON.stringify({
          doi: '10.1000/test',
          expectedVersion: 2,
          idempotencyKey: 'metadata',
        }),
      }),
      {
        ...deps,
        researchLiteratureCollector: async () => {
          metadataCalls++
          throw new Error('must not send')
        },
      },
    )
    expect(metadataResponse?.status).toBe(403)
    expect(metadataCalls).toBe(0)
    expect(
      applyResearchPattern({
        store,
        campaignId: id,
        expectedVersion: 1,
        idempotencyKey: 'apply',
        pattern,
      }),
    ).toMatchObject({ ok: true, replayed: true })
    const denied = await advanceResearchPattern({
      store,
      workspaceRoot: root,
      campaignId: id,
      expectedVersion: applied.version,
    })
    expect(denied.ok).toBe(false)
    expect(getResearchCampaign(store, id)!.attempts).toHaveLength(0)
    for (let step = 0; step < 2; step++) {
      const current = getResearchCampaign(store, id)!
      const state = researchPatternStatus(current)
      const approved = mutateResearchCampaign(store, id, {
        expectedVersion: current.version,
        idempotencyKey: `approve-${step}`,
        command: {
          kind: 'approve',
          bundleHash: current.bundleHash,
          reviewer: {
            reviewerId: 'test-signed-channel',
            proofId: crypto.randomUUID(),
            verifiedAt: Date.now(),
          },
          scope: {
            kind: 'execution',
            taskRevisionId: state.taskRevisionId!,
            dispatchKey: state.dispatchKey!,
            artifactVersionIds: [],
            currency: 'USD',
            maxCost: 0,
            expiresAt: Date.now() + 60_000,
          },
        },
      })
      if (!approved.ok) throw new Error(approved.message)
      const started = await advanceResearchPattern({
        store,
        workspaceRoot: root,
        campaignId: id,
        expectedVersion: approved.campaign.version,
        approvalId: approved.campaign.approvals.at(-1)!.id,
      })
      if (!started.ok) throw new Error(started.error)
      for (
        let i = 0;
        i < 100 && getResearchCampaign(store, id)!.attempts.at(-1)!.status === 'running';
        i++
      )
        await Bun.sleep(10)
      expect(getResearchCampaign(store, id)!.attempts.at(-1)!.status).toBe('completed')
    }
    const completed = getResearchCampaign(store, id)!
    expect(researchPatternStatus(completed)).toMatchObject({ nextAction: 'approved-model-review' })
    expect(completed.attempts).toHaveLength(2)
    expect(
      researchPatternStatus(completed).stages.find((s) => s.stageId === 'release')?.status,
    ).toBe('pending')
    const changed = mutateResearchCampaign(store, id, {
      expectedVersion: completed.version,
      idempotencyKey: 'change',
      command: { kind: 'setPolicy', policy: { changed: true } },
    })
    if (!changed.ok) throw new Error(changed.message)
    expect(researchPatternStatus(changed.campaign).nextAction).toBe('replan-required')
    await expect(
      advanceResearchPattern({
        store,
        workspaceRoot: root,
        campaignId: id,
        expectedVersion: changed.campaign.version,
      }),
    ).rejects.toThrow('No fixed execution')
    const replanned = applyResearchPattern({
      store,
      campaignId: id,
      expectedVersion: changed.campaign.version,
      idempotencyKey: 'replan',
      pattern,
    })
    expect(replanned).toMatchObject({ ok: true, campaign: { patternHistory: [applied.pattern] } })
    if (!replanned.ok) throw new Error(replanned.message)
    expect(replanned.campaign.taskRevisions).toHaveLength(4)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
