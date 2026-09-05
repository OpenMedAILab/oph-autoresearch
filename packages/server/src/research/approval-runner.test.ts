import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ResearchApprovalScope, ResearchCommand } from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import fixture from '../../../../fixtures/synthetic-summary.json'
import { startSyntheticRun } from './synthetic-runner.ts'
import { SYNTHETIC_SKILL_BINDING } from './synthetic-skill.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fresh() {
  const base = join(resolve(import.meta.dir, '../../../..'), '.tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'approval-runner-'))
  roots.push(root)
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, root, 'approval-runner')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'approval-campaign',
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'approval-gated synthetic summary',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 10 },
  })
  if (!created.ok) throw new Error(created.message)
  return { store, root, campaign: created.campaign }
}

function write(
  store: Store,
  campaignId: string,
  version: number,
  command: ResearchCommand,
  key: string,
) {
  return mutateResearchCampaign(store, campaignId, {
    expectedVersion: version,
    idempotencyKey: key,
    command,
  })
}

function declare(store: Store, campaign: ReturnType<typeof getResearchCampaign>) {
  if (!campaign) throw new Error('missing campaign')
  const result = write(
    store,
    campaign.id,
    campaign.version,
    {
      kind: 'declareSyntheticTask',
      taskId: 'fixed-summary',
      templateId: 'synthetic-summary-v1',
      skillBinding: SYNTHETIC_SKILL_BINDING,
      inputHash: fixture.inputHash,
      artifactVersionIds: [],
    },
    'declare',
  )
  if (!result.ok) throw new Error(result.message)
  return result.campaign
}

function approve(
  store: Store,
  campaign: NonNullable<ReturnType<typeof getResearchCampaign>>,
  approvalId: string,
  scope: ResearchApprovalScope | undefined,
  proofId = `proof-${approvalId}`,
) {
  return write(
    store,
    campaign.id,
    campaign.version,
    {
      kind: 'approve',
      approvalId,
      bundleHash: campaign.bundleHash,
      reviewer: { reviewerId: 'reviewer', proofId, verifiedAt: Date.now() },
      ...(scope ? { scope } : {}),
    },
    `approve-${approvalId}`,
  )
}

function executionScope(
  taskRevisionId: string,
  dispatchKey: string,
  expiresAt = Date.now() + 60_000,
): ResearchApprovalScope {
  return {
    kind: 'execution',
    expiresAt,
    currency: 'USD',
    maxCost: 1,
    taskRevisionId,
    dispatchKey,
    artifactVersionIds: [],
  }
}

describe('approval-gated synthetic runner', () => {
  test('an exact active execution approval permits one dispatch and its idempotent replay only', async () => {
    const { store, root, campaign } = await fresh()
    const declared = declare(store, campaign)
    const task = declared.taskRevisions[0]!
    const approved = approve(
      store,
      declared,
      'approve-exact',
      executionScope(task.id, 'approved-dispatch'),
    )
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    const first = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: approved.campaign.version,
      dispatchKey: 'approved-dispatch',
      taskRevisionId: task.id,
      requireApproval: true,
      approvalId: 'approve-exact',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const replay = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: first.campaign.version,
      dispatchKey: 'approved-dispatch',
      taskRevisionId: task.id,
      requireApproval: true,
      approvalId: 'approve-exact',
    })
    expect(replay).toMatchObject({ ok: true, replayed: true, attemptId: first.attemptId })
    const other = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: first.campaign.version,
      dispatchKey: 'other-dispatch',
      taskRevisionId: task.id,
      requireApproval: true,
      approvalId: 'approve-exact',
    })
    expect(other).toMatchObject({ ok: false, code: 'approval_required' })
    expect(getResearchCampaign(store, campaign.id)?.approvals[0]?.consumedBy).toBe(first.attemptId)
    store.close()
  })

  test('missing, legacy, revoked, expired, and wrong-scope approvals cannot dispatch', async () => {
    const { store, root, campaign } = await fresh()
    const declared = declare(store, campaign)
    const task = declared.taskRevisions[0]!
    const denied = async (approvalId?: string) =>
      startSyntheticRun({
        store,
        workspaceRoot: root,
        campaignId: campaign.id,
        expectedVersion: getResearchCampaign(store, campaign.id)!.version,
        dispatchKey: 'blocked',
        taskRevisionId: task.id,
        requireApproval: true,
        ...(approvalId ? { approvalId } : {}),
      })
    expect(await denied()).toMatchObject({ ok: false, code: 'approval_required' })
    const legacy = approve(store, declared, 'legacy', undefined)
    expect(legacy.ok).toBe(true)
    expect(await denied('legacy')).toMatchObject({ ok: false, code: 'approval_required' })
    const wrong = approve(store, getResearchCampaign(store, campaign.id)!, 'wrong', {
      ...executionScope(task.id, 'other-key'),
      kind: 'protocol',
      artifactVersionIds: [],
    })
    expect(wrong.ok).toBe(true)
    expect(await denied('wrong')).toMatchObject({ ok: false, code: 'approval_required' })
    const expired = approve(
      store,
      getResearchCampaign(store, campaign.id)!,
      'expired',
      executionScope(task.id, 'blocked', Date.now() - 1),
    )
    expect(expired).toMatchObject({ ok: false, code: 'invalid_approval_scope' })
    const active = approve(
      store,
      getResearchCampaign(store, campaign.id)!,
      'revoked',
      executionScope(task.id, 'blocked'),
    )
    expect(active.ok).toBe(true)
    if (active.ok) {
      const revoked = write(
        store,
        campaign.id,
        active.campaign.version,
        {
          kind: 'revokeApproval',
          approvalId: 'revoked',
          reviewer: { reviewerId: 'reviewer', proofId: 'revoke-proof', verifiedAt: Date.now() },
        },
        'revoke',
      )
      expect(revoked.ok).toBe(true)
      expect(await denied('revoked')).toMatchObject({ ok: false, code: 'approval_required' })
    }
    store.close()
  })

  test('proof ids are globally single-use across approvals, while release consumes an exact verified artifact approval', async () => {
    const { store, root, campaign } = await fresh()
    const completed = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'unapproved-summary',
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) return
    const current = getResearchCampaign(store, campaign.id)!
    const artifactId = current.artifactVersions[0]!.id
    const releaseScope: ResearchApprovalScope = {
      kind: 'release',
      expiresAt: Date.now() + 60_000,
      currency: 'USD',
      maxCost: 1,
      artifactVersionIds: [artifactId],
    }
    const approved = approve(store, current, 'release-approval', releaseScope, 'shared-proof')
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    const replayedProof = approve(
      store,
      approved.campaign,
      'second-approval',
      releaseScope,
      'shared-proof',
    )
    expect(replayedProof).toMatchObject({ ok: false, code: 'replayed_human_proof' })
    const released = write(
      store,
      campaign.id,
      approved.campaign.version,
      { kind: 'release', approvalId: 'release-approval', artifactVersionIds: [artifactId] },
      'release',
    )
    expect(released).toMatchObject({ ok: true, campaign: { status: 'completed', stage: 'output' } })
    if (released.ok) expect(released.campaign.approvals[0]?.consumedBy).toMatch(/^release:/)
    store.close()
  })
})
