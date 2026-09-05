import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { startSyntheticRun } from '../packages/server/src/research/synthetic-runner.ts'
import { runResearchBackupDrill } from './research-backup-drill.ts'

const roots: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(resolve(import.meta.dir, '..', '.tmp'), 'backup-drill-'))
  roots.push(root)
  const dbPath = join(root, 'ledger.sqlite')
  const store = new Store({ path: dbPath })
  stores.push(store)
  const workspace = upsertWorkspace(store, root, 'backup-drill')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fixture',
    model: 'fixture',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'backup-drill-campaign',
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'fixture backup drill',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 10 },
  })
  if (!created.ok) throw new Error(created.message)
  const executed = await startSyntheticRun({
    store,
    workspaceRoot: root,
    campaignId: created.campaign.id,
    expectedVersion: created.campaign.version,
    dispatchKey: 'backup-attempt',
  })
  if (!executed.ok) throw new Error(executed.error)
  const afterExecution = getResearchCampaign(store, created.campaign.id)!
  const artifactFile = fileURLToPath(afterExecution.artifactVersions[0]!.uri)
  const artifactRelativePath = relative(root, artifactFile)
  const secondArtifactFile = join(root, 'fixture-aggregate.json')
  const secondArtifactBytes = new TextEncoder().encode('{"aggregate":true}\n')
  await writeFile(secondArtifactFile, secondArtifactBytes, { flag: 'wx' })
  const recorded = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: afterExecution.version,
    idempotencyKey: 'backup-drill-second-artifact',
    command: {
      kind: 'recordArtifact',
      artifactId: 'fixture-aggregate',
      artifactKind: 'fixture-aggregate',
      contentHash: `sha256:${createHash('sha256').update(secondArtifactBytes).digest('hex')}`,
      uri: pathToFileURL(secondArtifactFile).href,
    },
  })
  if (!recorded.ok) throw new Error(recorded.message)
  const afterArtifacts = recorded.campaign
  const artifactVersionId = afterArtifacts.artifactVersions[0]!.id
  const secondArtifactRelativePath = relative(root, secondArtifactFile)
  const approved = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: afterArtifacts.version,
    idempotencyKey: 'backup-drill-approval',
    command: {
      kind: 'approve',
      bundleHash: afterArtifacts.bundleHash,
      reviewer: { reviewerId: 'reviewer-1', proofId: 'proof-1', verifiedAt: Date.now() },
      scope: {
        kind: 'model_review',
        dispatchKey: 'backup-review',
        evidencePackHash: `sha256:${'b'.repeat(64)}`,
        configHash: `sha256:${'c'.repeat(64)}`,
        maxRequests: 2,
        maxOutputTokens: 1024,
        expiresAt: Date.now() + 60_000,
        currency: 'USD',
        maxCost: 1,
        artifactVersionIds: [artifactVersionId],
      },
    },
  })
  if (!approved.ok) throw new Error(approved.message)
  const reserved = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: approved.campaign.version,
    idempotencyKey: 'backup-drill-reserve-review',
    command: {
      kind: 'reserveModelReview',
      spec: {
        dispatchKey: 'backup-review',
        approvalId: approved.campaign.approvals[0]!.id,
        evidencePackHash: `sha256:${'b'.repeat(64)}`,
        configHash: `sha256:${'c'.repeat(64)}`,
        artifactVersionIds: [artifactVersionId],
        currency: 'USD',
        reservedCost: 1,
        maxRequests: 2,
        maxOutputTokens: 1024,
      },
    },
  })
  if (!reserved.ok) throw new Error(reserved.message)
  const reviewId = reserved.campaign.modelReviews![0]!.id
  const started = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: reserved.campaign.version,
    idempotencyKey: 'backup-drill-start-review',
    command: { kind: 'startModelReviewRequest', reviewId },
  })
  if (!started.ok) throw new Error(started.message)
  const finished = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: started.campaign.version,
    idempotencyKey: 'backup-drill-finish-review',
    command: {
      kind: 'finishModelReview',
      reviewId,
      runId: 'fixture-run',
      conversationId: 'fixture-conversation',
      text: 'fixture review',
      status: 'done',
      actualCost: 1,
    },
  })
  if (!finished.ok) throw new Error(finished.message)
  return {
    root,
    dbPath,
    artifactRelativePaths: [artifactRelativePath, secondArtifactRelativePath].sort(),
    campaignId: finished.campaign.id,
    store,
  }
}

describe('research backup drill', () => {
  test('serializes and restores a fixture ledger and explicitly allowlisted artifact bytes', async () => {
    const prepared = await fixture()
    const outputBase = resolve(import.meta.dir, '..', '.tmp')
    roots.push(
      join(outputBase, `backup-output-${basename(prepared.root)}`),
      join(outputBase, `restore-output-${basename(prepared.root)}`),
    )
    const result = await runResearchBackupDrill({
      sourceDbPath: prepared.dbPath,
      sourceArtifactRoot: prepared.root,
      artifactFiles: prepared.artifactRelativePaths,
      campaignIds: [prepared.campaignId],
      backupRoot: join(outputBase, `backup-output-${basename(prepared.root)}`),
      restoreRoot: join(outputBase, `restore-output-${basename(prepared.root)}`),
    })
    expect(result.backupDbHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.keys(result.artifactHashes).sort()).toEqual(prepared.artifactRelativePaths)
    expect(Object.values(result.artifactHashes)).toSatisfy((hashes) =>
      hashes.every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash)),
    )
    expect(result.campaignHashes).toEqual({
      [prepared.campaignId]: expect.stringMatching(/^sha256:/),
    })
    expect(result.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    const restored = new Store({
      path: join(outputBase, `restore-output-${basename(prepared.root)}`, 'ledger.sqlite'),
    })
    try {
      expect(getResearchCampaign(restored, prepared.campaignId)?.approvals).toHaveLength(1)
      expect(getResearchCampaign(restored, prepared.campaignId)?.artifactVersions).toHaveLength(2)
      expect(getResearchCampaign(restored, prepared.campaignId)?.attempts).toHaveLength(1)
      expect(getResearchCampaign(restored, prepared.campaignId)?.modelReviews).toHaveLength(1)
      expect(
        restored.db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all(),
      ).toEqual([{ integrity_check: 'ok' }])
      expect(restored.db.query('PRAGMA foreign_key_check').all()).toEqual([])
      const restoredBeforeNewSourceEvent = getResearchCampaign(restored, prepared.campaignId)!
      const sourceBeforeNewEvent = getResearchCampaign(prepared.store, prepared.campaignId)!
      const addedAfterSnapshot = mutateResearchCampaign(prepared.store, prepared.campaignId, {
        expectedVersion: sourceBeforeNewEvent.version,
        idempotencyKey: 'backup-drill-post-snapshot',
        command: { kind: 'setPolicy', policy: { afterSnapshot: true } },
      })
      expect(addedAfterSnapshot).toMatchObject({ ok: true })
      expect(getResearchCampaign(restored, prepared.campaignId)).toEqual(
        restoredBeforeNewSourceEvent,
      )
      expect(getResearchCampaign(restored, prepared.campaignId)?.artifactVersions[0]?.uri).toBe(
        getResearchCampaign(prepared.store, prepared.campaignId)?.artifactVersions[0]?.uri,
      )
    } finally {
      restored.close()
    }
  })

  test('refuses non-fixture source paths, credential-like names, and a source-parent backup target', async () => {
    const prepared = await fixture()
    const outputBase = resolve(import.meta.dir, '..', '.tmp')
    await expect(
      runResearchBackupDrill({
        sourceDbPath: 'C:\\real-user-ledger.sqlite',
        sourceArtifactRoot: prepared.root,
        artifactFiles: prepared.artifactRelativePaths,
        campaignIds: [prepared.campaignId],
        backupRoot: join(outputBase, `backup-invalid-${basename(prepared.root)}`),
        restoreRoot: join(outputBase, `restore-invalid-${basename(prepared.root)}`),
      }),
    ).rejects.toThrow('fixture or .tmp')
    await expect(
      runResearchBackupDrill({
        sourceDbPath: prepared.dbPath,
        sourceArtifactRoot: prepared.root,
        artifactFiles: ['private-key.pem'],
        campaignIds: [prepared.campaignId],
        backupRoot: join(outputBase, `backup-secret-${basename(prepared.root)}`),
        restoreRoot: join(outputBase, `restore-secret-${basename(prepared.root)}`),
      }),
    ).rejects.toThrow('credential-like')
    const before = await readFile(prepared.dbPath)
    await expect(
      runResearchBackupDrill({
        sourceDbPath: prepared.dbPath,
        sourceArtifactRoot: prepared.root,
        artifactFiles: prepared.artifactRelativePaths,
        campaignIds: [prepared.campaignId],
        backupRoot: prepared.root,
        restoreRoot: join(resolve(import.meta.dir, '..', '.tmp'), 'unused-restore-root'),
      }),
    ).rejects.toThrow(/overlap|must not already exist/)
    expect(await readFile(prepared.dbPath)).toEqual(before)

    const existingBackup = join(outputBase, `backup-existing-${basename(prepared.root)}`)
    roots.push(existingBackup)
    await mkdir(existingBackup)
    await writeFile(join(existingBackup, 'keep.txt'), 'do not replace')
    await expect(
      runResearchBackupDrill({
        sourceDbPath: prepared.dbPath,
        sourceArtifactRoot: prepared.root,
        artifactFiles: prepared.artifactRelativePaths,
        campaignIds: [prepared.campaignId],
        backupRoot: existingBackup,
        restoreRoot: join(outputBase, `restore-existing-${basename(prepared.root)}`),
      }),
    ).rejects.toThrow('must not already exist')
    expect(await Bun.file(join(existingBackup, 'keep.txt')).text()).toBe('do not replace')
  })
})
