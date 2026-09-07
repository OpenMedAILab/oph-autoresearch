import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchCommand } from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  rebuildResearchCampaignProjection,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import fixture from '../../../../fixtures/synthetic-summary.json'
import { startSyntheticRun } from './synthetic-runner.ts'
import { SYNTHETIC_SKILL_BINDING } from './synthetic-skill.ts'

test('exact artifact dependencies invalidate only their transitive consumers and persist revision lineage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oph-lineage-'))
  const store = new Store({ path: join(root, 'ledger.sqlite') })
  const workspace = upsertWorkspace(store, root, 'lineage')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    model: 'fake',
    provider: 'fake',
  })
  const created = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'synthetic lineage',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
    idempotencyKey: 'create',
  })
  if (!created.ok) throw new Error(created.message)
  let campaign = created.campaign
  function write(command: ResearchCommand) {
    const result = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: campaign.version,
      idempotencyKey: crypto.randomUUID(),
      command,
    })
    if (!result.ok) throw new Error(result.message)
    campaign = result.campaign
    return campaign
  }
  function artifact(id: string, hash: string) {
    write({
      kind: 'recordArtifact',
      artifactId: id,
      contentHash: `sha256:${hash.repeat(64)}`,
      uri: 'fixture://synthetic',
      artifactKind: 'synthetic',
    })
    return campaign.artifactVersions.at(-1)!.id
  }
  async function task(taskId: string, artifactVersionIds: string[]) {
    write({
      kind: 'declareSyntheticTask',
      skillBinding: SYNTHETIC_SKILL_BINDING,
      taskId,
      artifactVersionIds,
      inputHash: fixture.inputHash,
    })
    const revision = campaign.taskRevisions.at(-1)!
    const result = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: taskId,
      taskRevisionId: revision.id,
    })
    if (!result.ok) throw new Error(result.error)
    campaign = result.campaign
    return { revision, output: campaign.artifactVersions.at(-1)!.id }
  }
  try {
    const a = artifact('input-a', 'a')
    const b = artifact('input-b', 'b')
    const first = await task('first', [a])
    const dependent = await task('dependent', [first.output])
    const unrelated = await task('unrelated', [b])
    const preservedAttempts = structuredClone(campaign.attempts)
    artifact('input-a', 'c')
    const status = (id: string) => campaign.taskRevisions.find((item) => item.id === id)!.status
    expect(status(first.revision.id)).toBe('stale')
    expect(status(dependent.revision.id)).toBe('stale')
    expect(status(unrelated.revision.id)).toBe('verified')
    expect(campaign.attempts).toEqual(preservedAttempts)
    expect(campaign.taskRevisions[0]?.skillBinding).toEqual(SYNTHETIC_SKILL_BINDING)
    expect(
      campaign.taskRevisions.find((item) => item.id === first.revision.id)!.artifactVersionIds,
    ).toEqual([a])
    const denied = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'stale-dispatch',
      taskRevisionId: first.revision.id,
    })
    expect(denied).toMatchObject({ ok: false, code: 'stale_task_revision' })
    write({
      kind: 'declareSyntheticTask',
      taskId: 'first',
      inputHash: fixture.inputHash,
      artifactVersionIds: [campaign.artifactVersions.at(-1)!.id],
      previousRevisionId: first.revision.id,
    })
    expect(campaign.taskRevisions.at(-1)).toMatchObject({
      revision: 2,
      previousRevisionId: first.revision.id,
    })
    const before = structuredClone(campaign)
    rebuildResearchCampaignProjection(store, campaign.id)
    expect(getResearchCampaign(store, campaign.id)).toEqual(before)
  } finally {
    store.close()
  }
})

test('a rerun of one task creates the next artifact version and stales its actual consumers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oph-rerun-lineage-'))
  const store = new Store({ path: join(root, 'ledger.sqlite') })
  const workspace = upsertWorkspace(store, root, 'rerun-lineage')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    model: 'fake',
    provider: 'fake',
  })
  const created = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'rerun lineage',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
    idempotencyKey: 'create-rerun',
  })
  if (!created.ok) throw new Error(created.message)
  let campaign = created.campaign
  const write = (command: ResearchCommand) => {
    const result = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: campaign.version,
      idempotencyKey: crypto.randomUUID(),
      command,
    })
    if (!result.ok) throw new Error(result.message)
    campaign = result.campaign
  }
  try {
    write({
      kind: 'recordArtifact',
      artifactId: 'input',
      contentHash: `sha256:${'a'.repeat(64)}`,
      uri: 'fixture://input',
      artifactKind: 'synthetic',
    })
    const input = campaign.artifactVersions[0]!.id
    write({
      kind: 'declareSyntheticTask',
      skillBinding: SYNTHETIC_SKILL_BINDING,
      taskId: 'producer',
      artifactVersionIds: [input],
      inputHash: fixture.inputHash,
    })
    const producer = campaign.taskRevisions[0]!
    const first = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'producer-first',
      taskRevisionId: producer.id,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    campaign = first.campaign
    const firstOutput = campaign.artifactVersions.at(-1)!
    write({
      kind: 'declareSyntheticTask',
      skillBinding: SYNTHETIC_SKILL_BINDING,
      taskId: 'consumer',
      artifactVersionIds: [firstOutput.id],
      inputHash: fixture.inputHash,
    })
    const consumer = campaign.taskRevisions.at(-1)!

    const rerun = await startSyntheticRun({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'producer-rerun',
      taskRevisionId: producer.id,
    })
    expect(rerun.ok).toBe(true)
    if (!rerun.ok) return
    campaign = rerun.campaign
    expect(
      campaign.artifactVersions
        .filter((artifact) => artifact.artifactId === producer.id)
        .map((artifact) => artifact.version),
    ).toEqual([1, 2])
    expect(campaign.taskRevisions.find((task) => task.id === consumer.id)?.status).toBe('stale')
  } finally {
    store.close()
  }
})
