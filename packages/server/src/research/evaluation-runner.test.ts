import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { fixedResearchTemplate } from './template-registry.ts'

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
    campaign: created.campaign,
    protocol: syntheticProtocol(store, root, created.campaign.id),
  }
}

describe('fixed synthetic evaluation runner', () => {
  test.each(['synthetic-evaluation-v1', 'synthetic-training-evaluation-v1'] as const)(
    'runs, replays and receipts aggregate-only %s',
    async (templateId) => {
      const { store, root, campaign, protocol } = await fresh()
      const first = await protocol.submit({
        expectedVersion: campaign.version,
        dispatchKey: 'evaluation-once',
        templateId,
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const replay = await protocol.submit({
        expectedVersion: first.campaign.version,
        dispatchKey: 'evaluation-once',
        templateId,
      })
      expect(replay).toMatchObject({ ok: true, replayed: true, attemptId: first.attemptId })
      const receipt = await protocol.receipt(first.attemptId)
      expect(receipt).toMatchObject({
        reviewKind: 'fixed-contract-recomputation',
        inputHash: expect.stringMatching(/^sha256:/),
      })

      const stored = getResearchCampaign(store, campaign.id)!
      const task = stored.taskRevisions[0]!
      const artifact = stored.artifactVersions[0]!
      expect(task).toMatchObject({
        templateId,
        outputContract: templateId,
        stageId: 'evaluation',
      })
      expect(artifact).toMatchObject({
        kind: templateId,
        schemaId: templateId,
        mediaType: 'application/json',
        dataClass: 'synthetic',
        producerAttemptId: first.attemptId,
        producerTaskRevisionId: task.id,
        validation: { contentHash: artifact.contentHash },
      })
      const bytes = await readFile(
        join(
          root,
          '.oph',
          'research',
          campaign.id,
          first.attemptId,
          fixedResearchTemplate(templateId).filename,
        ),
      )
      const text = new TextDecoder().decode(bytes)
      expect(text).toContain('confidenceIntervals')
      expect(text).not.toContain('test-a')
      expect(text).not.toContain('patientId')
      store.close()
    },
  )

  test('rejects a dispatch replay under another template and a mismatched task template', async () => {
    const { store, campaign, protocol } = await fresh()
    const first = await protocol.submit({
      expectedVersion: campaign.version,
      dispatchKey: 'template-locked',
      templateId: 'synthetic-evaluation-v1',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const mixed = await protocol.submit({
      expectedVersion: first.campaign.version,
      dispatchKey: 'template-locked',
      templateId: 'synthetic-summary-v1',
    })
    expect(mixed).toMatchObject({ ok: false, code: 'dispatch_key_conflict' })
    const wrongTask = await protocol.submit({
      expectedVersion: first.campaign.version,
      dispatchKey: 'wrong-task-template',
      templateId: 'synthetic-summary-v1',
      taskRevisionId: first.campaign.taskRevisions[0]!.id,
    })
    expect(wrongTask).toMatchObject({ ok: false, code: 'skill_binding_conflict' })
    store.close()
  })

  test('summary template remains compatible and evaluation receipts reject tampered bytes', async () => {
    const summary = await fresh()
    const normal = await summary.protocol.submit({
      expectedVersion: summary.campaign.version,
      dispatchKey: 'summary-default',
    })
    expect(normal.ok).toBe(true)
    if (!normal.ok) return
    expect(
      summary.store
        ? getResearchCampaign(summary.store, summary.campaign.id)?.taskRevisions[0]?.templateId
        : null,
    ).toBe('synthetic-summary-v1')
    summary.store.close()

    const evaluation = await fresh()
    const run = await evaluation.protocol.submit({
      expectedVersion: evaluation.campaign.version,
      dispatchKey: 'tampered-evaluation',
      templateId: 'synthetic-evaluation-v1',
    })
    expect(run.ok).toBe(true)
    if (!run.ok) return
    const path = join(
      evaluation.root,
      '.oph',
      'research',
      evaluation.campaign.id,
      run.attemptId,
      'evaluation.json',
    )
    await writeFile(path, `${await readFile(path, 'utf8')}\n`, 'utf8')
    await expect(evaluation.protocol.receipt(run.attemptId)).rejects.toThrow('回执产物字节已变化')
    evaluation.store.close()
  })
})
