/** Coverage: synthetic-runner.ts local fixture execution, byte verification, cancellation, and path safety. */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { cancelSyntheticRun, startSyntheticRun } from './synthetic-runner.ts'
import { FIRST_PARTY_SYNTHETIC_SKILL } from './synthetic-skill.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fresh() {
  const tempRoot = join(resolve(import.meta.dir, '../../../..'), '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const workspaceRoot = await mkdtemp(join(tempRoot, 'synthetic-runner-'))
  roots.push(workspaceRoot)
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, workspaceRoot, 'synthetic')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'campaign',
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'validate a synthetic retinal summary',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!created.ok) throw new Error(created.message)
  return { store, workspaceRoot, campaign: created.campaign }
}

function hash(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return `sha256:${hasher.digest('hex')}`
}

describe('固定合成摘要运行器', () => {
  test('篡改固定技能清单会在账本 claim 或输出写入之前拒绝', async () => {
    const { store, workspaceRoot, campaign } = await fresh()

    const result = await startSyntheticRun(
      {
        store,
        workspaceRoot,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'synthetic-invalid-skill',
      },
      {
        skillManifest: {
          ...FIRST_PARTY_SYNTHETIC_SKILL,
          source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, network: 'allow' },
        },
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_synthetic_runner_input',
      error: '固定合成技能清单无效',
    })
    expect(getResearchCampaign(store, campaign.id)?.attempts).toEqual([])
    await expect(stat(join(workspaceRoot, '.oph'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('只用内置 fixture 写入、重读并核验摘要后才完成账本', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    const result = await startSyntheticRun({
      store,
      workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'synthetic-1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const outputPath = join(
      workspaceRoot,
      '.oph',
      'research',
      campaign.id,
      result.attemptId,
      'summary.json',
    )
    const bytes = await readFile(outputPath)
    const summary = JSON.parse(new TextDecoder().decode(bytes)) as {
      schema: string
      inputHash: string
      statistics: { count: number; mean: number; min: number; max: number }
    }
    expect(summary).toEqual({
      schema: 'synthetic-summary-v1',
      inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
      statistics: { count: 8, mean: 39.375, min: 12, max: 73 },
    })
    const stored = getResearchCampaign(store, campaign.id)
    expect(stored?.attempts[0]).toMatchObject({ status: 'completed', id: result.attemptId })
    expect(stored?.taskRevisions[0]).toMatchObject({
      templateId: 'synthetic-summary-v1',
      dataClass: 'synthetic',
      status: 'verified',
    })
    expect(stored?.artifactVersions[0]?.contentHash).toBe(hash(bytes))
    expect(stored?.approvals).toEqual([])
  })

  test('同一 dispatch 不会执行第二次或新增 attempt', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    const first = await startSyntheticRun({
      store,
      workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'synthetic-once',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const replay = await startSyntheticRun({
      store,
      workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: first.campaign.version,
      dispatchKey: 'synthetic-once',
    })

    expect(replay).toMatchObject({ ok: true, replayed: true, attemptId: first.attemptId })
    expect(getResearchCampaign(store, campaign.id)?.attempts).toHaveLength(1)
  })

  test('写入时发现已有文件不覆盖，保留 attempt 目录并把账本置 failed', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    let outputPath = ''
    const result = await startSyntheticRun(
      {
        store,
        workspaceRoot,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'synthetic-write-failure',
      },
      {
        beforeWrite: async ({ outputPath: path }) => {
          outputPath = path
          await writeFile(path, 'forged summary', 'utf8')
        },
      },
    )

    expect(result.ok).toBe(false)
    expect((await stat(join(outputPath, '..'))).isDirectory()).toBe(true)
    expect(await readFile(outputPath, 'utf8')).toBe('forged summary')
    expect(getResearchCampaign(store, campaign.id)?.attempts[0]).toMatchObject({ status: 'failed' })
  })

  test('通知回调抛出时不阻断账本终态', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    const result = await startSyntheticRun({
      store,
      workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'synthetic-notify-failure',
      onChange: () => {
        throw new Error('injected notification failure')
      },
    })

    expect(result.ok).toBe(true)
    expect(getResearchCampaign(store, campaign.id)?.attempts[0]).toMatchObject({
      status: 'completed',
    })
  })

  test('中途取消先持久记录请求，停止写入后以 cancelled 收尾', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    let release!: () => void
    let entered!: () => void
    let outputPath = ''
    const boundary = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredWrite = new Promise<void>((resolve) => {
      entered = resolve
    })
    const running = startSyntheticRun(
      {
        store,
        workspaceRoot,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        dispatchKey: 'synthetic-cancel',
      },
      {
        beforeWrite: async ({ outputPath: path }) => {
          outputPath = path
          entered()
          await boundary
        },
      },
    )

    await enteredWrite
    const claimed = getResearchCampaign(store, campaign.id)!
    const attempt = claimed.attempts[0]!
    const cancelled = cancelSyntheticRun({
      store,
      campaignId: campaign.id,
      expectedVersion: claimed.version,
      attemptId: attempt.id,
    })
    expect(cancelled.ok).toBe(true)
    release()
    const result = await running

    expect(result.ok).toBe(false)
    expect(getResearchCampaign(store, campaign.id)?.attempts[0]).toMatchObject({
      status: 'cancelled',
      cancelRequestedAt: expect.any(Number),
    })
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('拒绝 .oph 软链接，不能把合成结果写出工作区', async () => {
    const { store, workspaceRoot, campaign } = await fresh()
    const outside = await mkdtemp(join(resolve(workspaceRoot, '..'), 'synthetic-outside-'))
    roots.push(outside)
    await symlink(
      outside,
      join(workspaceRoot, '.oph'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const result = await startSyntheticRun({
      store,
      workspaceRoot,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      dispatchKey: 'synthetic-symlink',
    })

    expect(result.ok).toBe(false)
    expect(getResearchCampaign(store, campaign.id)?.attempts[0]).toMatchObject({ status: 'failed' })
    expect(await readdir(outside)).toEqual([])
  })
})
