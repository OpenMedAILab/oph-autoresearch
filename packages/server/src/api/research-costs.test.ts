import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalResearchBundle, type ResearchCampaign } from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { createHumanAuthVerifier } from '../research/human-auth.ts'
import { canonicalJson, sha256 } from '../research/skill-lock.ts'
import { handleResearchApi } from './research.ts'
import type { ApiRequestDeps } from './types.ts'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new Store({ path: ':memory:' })
  stores.push(store)
  const workspace = upsertWorkspace(store, '/fixture/cost-review', '费用验收项目')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fixture',
    model: 'fixture',
  })
  const created = createResearchCampaign(store, {
    parentConversationId: conversation.id,
    workspaceId: workspace.id,
    goal: '费用核账测试',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 100 },
    idempotencyKey: 'create',
  })
  if (!created.ok) throw new Error(created.message)
  const snapshot: ResearchCampaign = {
    ...created.campaign,
    modelReviews: [
      {
        id: 'review-fixture',
        dispatchKey: 'review-fixture',
        approvalId: 'prior-review-approval',
        evidencePackHash: sha256('evidence'),
        configHash: sha256('config'),
        artifactVersionIds: [],
        currency: 'USD',
        reservedCost: 10,
        maxRequests: 2,
        maxOutputTokens: 1024,
        requestCount: 1,
        status: 'failed',
        executionOutcome: 'failed',
        ownerPid: process.pid,
        actualCost: null,
      },
    ],
  }
  snapshot.bundleHash = sha256(canonicalResearchBundle(snapshot))
  store.db
    .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(snapshot), snapshot.id)
  const keys = generateKeyPairSync('ed25519')
  const deps = {
    store,
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    bus: new EventBus(),
    researchHumanAuth: createHumanAuthVerifier({
      issuers: { fixture: { publicKey: keys.publicKey, reviewerIds: ['human-fixture'] } },
    }),
  } as unknown as ApiRequestDeps
  const proof = (body: unknown) => {
    const encoded = Buffer.from(
      canonicalJson({
        issuer: 'fixture',
        reviewerId: 'human-fixture',
        proofId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        workspaceId: workspace.id,
        campaignId: snapshot.id,
        action: 'approve',
        bodyHash: sha256(canonicalJson(body)),
      }),
    ).toString('base64url')
    return `v1.${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString('base64url')}`
  }
  const call = async (action: string, body?: unknown, header?: string, scoped = deps) => {
    const url = new URL(`http://localhost/api/research/campaigns/${snapshot.id}/${action}`)
    return (await handleResearchApi(
      url,
      new Request(
        url.toString(),
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: header ? { 'x-oph-human-proof': header } : {},
              body: JSON.stringify(body),
            },
      ),
      scoped,
    ))!
  }
  return {
    store,
    workspace,
    deps,
    call,
    proof,
    campaign: () => getResearchCampaign(store, snapshot.id)!,
  }
}
test('费用HTTP链路需精确独立签署，篡改金额和未签结算均拒绝，重放不重复核销', async () => {
  const f = fixture()
  const typo = {
    expectedVersion: f.campaign().version,
    idempotencyKey: 'unsigned-typo',
    subject: { kind: 'model_review', id: 'review-fixture' },
    amount: 500000,
    description: '尚未签署的错误金额',
  }
  expect((await f.call('costs/evidence', typo)).status).toBe(200)
  expect(await (await f.call('costs')).json()).toMatchObject({
    summary: { committedCost: 10, overLimit: false },
  })
  const record = {
    expectedVersion: f.campaign().version,
    idempotencyKey: 'record-cost',
    subject: { kind: 'model_review', id: 'review-fixture' },
    amount: 0.5,
    description: '人工核对fixture账单',
  }
  expect((await f.call('costs/evidence', record)).status).toBe(200)
  expect((await f.call('costs/evidence', record)).status).toBe(200)
  expect(f.campaign().costEvidence).toHaveLength(2)
  const evidence = f.campaign().costEvidence!.find((item) => item.amount === 0.5)!
  const unsigned = {
    expectedVersion: f.campaign().version,
    idempotencyKey: 'settle-before-approval',
    evidenceId: evidence.id,
    approvalId: 'invented',
  }
  expect((await f.call('costs/settle', unsigned)).status).toBe(400)
  const quote = (await (await f.call(`costs/quote?evidenceId=${evidence.id}`)).json()) as {
    body: { scope: { costAmount: number; maxCost: number }; expectedVersion: number }
  }
  const proof = f.proof(quote.body)
  expect((await f.call('approve', quote.body)).status).toBe(403)
  expect(
    (
      await f.call(
        'approve',
        { ...quote.body, scope: { ...quote.body.scope, costAmount: 0, maxCost: 0 } },
        proof,
      )
    ).status,
  ).toBe(403)
  expect((await f.call('approve', quote.body, proof)).status).toBe(200)
  const approval = f.campaign().approvals.find((item) => item.scope?.kind === 'cost_settlement')!
  const settle = {
    expectedVersion: f.campaign().version,
    idempotencyKey: 'settle-once',
    evidenceId: evidence.id,
    approvalId: approval.id,
  }
  expect((await f.call('costs/settle', settle)).status).toBe(200)
  expect((await f.call('costs/settle', settle)).status).toBe(200)
  expect(f.campaign().costSettlements).toHaveLength(1)
  expect(await (await f.call('costs')).json()).toMatchObject({
    summary: {
      settledCost: 0.5,
      committedCost: 0.5,
      subjects: [
        {
          settled: true,
          settledAmount: 0.5,
          knownActualCost: 0.5,
          knownActualSource: 'human-attestation',
        },
      ],
    },
  })
})
test('费用接口保留项目隔离，拒绝伪造服务商来源及未知对象', async () => {
  const f = fixture()
  const other = { ...f.deps, workspaceId: 'different-workspace' }
  expect((await f.call('costs', undefined, undefined, other)).status).toBe(404)
  const body = {
    expectedVersion: f.campaign().version,
    idempotencyKey: 'invalid',
    subject: { kind: 'model_review', id: 'review-fixture' },
    amount: 1,
    description: 'fixture',
  }
  expect((await f.call('costs/evidence', body, undefined, other)).status).toBe(404)
  expect((await f.call('costs/evidence', { ...body, source: 'provider-receipt' })).status).toBe(400)
  expect(
    (await f.call('costs/evidence', { ...body, subject: { kind: 'model_review', id: 'unknown' } }))
      .status,
  ).toBe(400)
  expect(f.campaign().costEvidence ?? []).toHaveLength(0)
})
