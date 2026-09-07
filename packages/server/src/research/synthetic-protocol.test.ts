/** Coverage: the local-synthetic protocol observes one ledger-backed runner; it never retries by observation. */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { startSyntheticRun } from './synthetic-runner.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fresh() {
  const tempRoot = join(resolve(import.meta.dir, '../../../..'), '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const workspaceRoot = await mkdtemp(join(tempRoot, 'synthetic-protocol-'))
  roots.push(workspaceRoot)
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, workspaceRoot, 'synthetic-protocol')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'campaign',
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'validate local synthetic protocol receipts',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!created.ok) throw new Error(created.message)
  return {
    store,
    workspaceRoot,
    campaign: created.campaign,
    protocol: syntheticProtocol(store, workspaceRoot, created.campaign.id),
  }
}

describe('local synthetic protocol', () => {
  test('same dispatch after a lost acknowledgement replays the one completed ledger attempt', async () => {
    const { store, campaign, protocol } = await fresh()
    const first = await protocol.submit({
      expectedVersion: campaign.version,
      dispatchKey: 'lost-ack',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Deliberately ignore `first`, as a caller that lost the acknowledgement would.
    const replay = await protocol.submit({
      expectedVersion: first.campaign.version,
      dispatchKey: 'lost-ack',
    })
    expect(replay).toMatchObject({ ok: true, attemptId: first.attemptId, replayed: true })
    expect(getResearchCampaign(store, campaign.id)?.attempts).toHaveLength(1)

    expect(protocol.status(first.attemptId)).toMatchObject({
      protocol: 'local-synthetic-v1',
      status: 'completed',
      cancelRequested: false,
      terminal: true,
      retryAllowed: false,
    })
  })

  test('receipt independently rereads bytes and returns the completed producer bindings', async () => {
    const { store, campaign, protocol } = await fresh()
    const submitted = await protocol.submit({
      expectedVersion: campaign.version,
      dispatchKey: 'receipt',
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return

    const receipt = await protocol.receipt(submitted.attemptId)
    const stored = getResearchCampaign(store, campaign.id)!
    const attempt = stored.attempts.find((item) => item.id === submitted.attemptId)!
    const task = stored.taskRevisions.find((item) => item.id === attempt.taskRevisionId)!
    const artifact = stored.artifactVersions.find((item) => item.id === attempt.artifactVersionId)!

    expect(receipt).toMatchObject({
      protocol: 'local-synthetic-v1',
      attemptId: submitted.attemptId,
      taskRevisionId: attempt.taskRevisionId,
      artifactVersionId: artifact.id,
      inputHash: task.inputHash,
      contentHash: artifact.contentHash,
      humanApproval: false,
      reviewKind: 'independent-machine',
    })
    expect(artifact).toMatchObject({
      producerAttemptId: submitted.attemptId,
      producerTaskRevisionId: attempt.taskRevisionId,
    })
    expect(receipt.consumedArtifactVersionIds).toEqual([])
  })

  test('receipt refuses a changed artifact even when it remains valid synthetic JSON', async () => {
    const { workspaceRoot, campaign, protocol } = await fresh()
    const submitted = await protocol.submit({
      expectedVersion: campaign.version,
      dispatchKey: 'tampered-receipt',
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    const outputPath = join(
      workspaceRoot,
      '.oph',
      'research',
      campaign.id,
      submitted.attemptId,
      'summary.json',
    )
    await writeFile(outputPath, `${await readFile(outputPath, 'utf8')}\n`, 'utf8')

    await expect(protocol.receipt(submitted.attemptId)).rejects.toThrow('回执产物字节已变化')
  })

  test('receipt refuses evidence whose task becomes stale while its independent read is pending', async () => {
    const { store, workspaceRoot, campaign, protocol } = await fresh()
    const submitted = await protocol.submit({
      expectedVersion: campaign.version,
      dispatchKey: 'stale-during-receipt',
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    const outputPath = join(
      workspaceRoot,
      '.oph',
      'research',
      campaign.id,
      submitted.attemptId,
      'summary.json',
    )
    const originalReadFile = fs.readFile
    let resumeRead!: () => void
    let observedRead!: () => void
    const readPaused = new Promise<void>((resolve) => {
      observedRead = resolve
    })
    const resume = new Promise<void>((resolve) => {
      resumeRead = resolve
    })
    const readSpy = spyOn(fs, 'readFile').mockImplementation((async (...args: unknown[]) => {
      const [path, options] = args
      if (String(path) === outputPath) {
        observedRead()
        await resume
      }
      return originalReadFile(path as never, options as never)
    }) as never)
    try {
      const receipt = protocol.receipt(submitted.attemptId)
      await readPaused
      const current = getResearchCampaign(store, campaign.id)!
      const stale = mutateResearchCampaign(store, campaign.id, {
        idempotencyKey: 'policy-during-receipt',
        expectedVersion: current.version,
        command: { kind: 'setPolicy', policy: { changed: true } },
      })
      expect(stale.ok).toBe(true)
      resumeRead()
      await expect(receipt).rejects.toThrow('回执证据在读取期间已失效')
    } finally {
      resumeRead()
      readSpy.mockRestore()
    }
  })

  test('cancel request is observable before the active runner reaches its cancelled terminal state', async () => {
    const { store, workspaceRoot, campaign, protocol } = await fresh()
    let release!: () => void
    let entered!: () => void
    const pendingWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    const writeEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const running = startSyntheticRun(
      {
        store,
        workspaceRoot,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'cancel-observation',
      },
      {
        beforeWrite: async () => {
          entered()
          await pendingWrite
        },
      },
    )

    await writeEntered
    const attemptId = getResearchCampaign(store, campaign.id)!.attempts[0]!.id
    expect(protocol.status(attemptId)).toMatchObject({
      status: 'running',
      cancelRequested: false,
      terminal: false,
      retryAllowed: false,
    })
    expect(protocol.cancel(attemptId)).toMatchObject({ ok: true, attemptId })
    expect(protocol.status(attemptId)).toMatchObject({
      status: 'running',
      cancelRequested: true,
      terminal: false,
      retryAllowed: false,
    })

    release()
    expect((await running).ok).toBe(false)
    expect(protocol.status(attemptId)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      terminal: true,
      retryAllowed: false,
    })
  })

  test('unknown attempts are rejected by every observation or control operation', async () => {
    const { protocol } = await fresh()
    expect(() => protocol.status('rat_unknown')).toThrow('找不到合成尝试')
    expect(() => protocol.cancel('rat_unknown')).toThrow('找不到合成尝试')
    await expect(protocol.receipt('rat_unknown')).rejects.toThrow('找不到合成尝试')
  })
})
