import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createConversation, Store, upsertWorkspace } from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { createHumanAuthVerifier, HUMAN_PROOF_HEADER } from '../research/human-auth.ts'
import { canonicalJson, sha256 } from '../research/skill-lock.ts'
import { installSupportedReviewFixture } from '../research/supported-review.fixture.ts'
import { SYNTHETIC_SKILL_BINDING } from '../research/synthetic-skill.ts'
import { handleResearchApi } from './research.ts'
import type { ApiRequestDeps } from './types.ts'

test('signed scoped HTTP approval is consumed by dispatch and verified release; bearer cannot bypass it', async () => {
  const root = await mkdtemp(
    join(resolve(import.meta.dir, '../../../..'), '.tmp', 'approval-http-'),
  )
  const store = new Store({ path: ':memory:' })
  try {
    const pair = generateKeyPairSync('ed25519')
    const workspace = upsertWorkspace(store, root, 'approval-http')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const deps = {
      store,
      workspaceId: workspace.id,
      workspaceRoot: root,
      bus: new EventBus(),
      researchRequireApproval: true,
      researchHumanAuth: createHumanAuthVerifier({
        issuers: { fixture: { publicKey: pair.publicKey, reviewerIds: ['reviewer'] } },
        now: () => now,
      }),
    } as unknown as ApiRequestDeps
    let now = Date.now()
    let proof = 0
    let previousHeader = ''
    async function call(path: string, body: unknown, signed: boolean | 'replay' = false) {
      const url = new URL(`http://localhost/api/research/campaigns${path}`)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (signed === 'replay') headers[HUMAN_PROOF_HEADER] = previousHeader
      else if (signed) {
        const claims = {
          issuer: 'fixture',
          reviewerId: 'reviewer',
          proofId: `http-${++proof}`,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          workspaceId: workspace.id,
          campaignId: path.split('/')[1],
          action: path.endsWith('/labelsets')
            ? 'labelset'
            : path.endsWith('/approve')
              ? 'approve'
              : 'revoke',
          bodyHash: sha256(canonicalJson(body)),
        }
        const payload = Buffer.from(canonicalJson(claims)).toString('base64url')
        headers[HUMAN_PROOF_HEADER] =
          `v1.${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
        previousHeader = headers[HUMAN_PROOF_HEADER]!
      }
      const response = (await handleResearchApi(
        url,
        new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(body) }),
        deps,
      ))!
      return {
        status: response.status,
        data: (await response.json()) as { campaign: ResearchCampaign; code?: string },
      }
    }
    let result = await call('', {
      goal: 'signed fixture approval',
      parentConversationId: parent.id,
      idempotencyKey: 'create',
    })
    const path = `/${result.data.campaign.id}`
    result = await call(`${path}/proposals`, {
      expectedVersion: 1,
      idempotencyKey: 'declare',
      command: {
        kind: 'declareSyntheticTask',
        taskId: 'smoke',
        inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
        artifactVersionIds: [],
        skillBinding: SYNTHETIC_SKILL_BINDING,
      },
    })
    let campaign = result.data.campaign
    const taskRevisionId = campaign.taskRevisions[0]!.id
    expect(
      (
        await call(`${path}/synthetic`, {
          expectedVersion: campaign.version,
          dispatchKey: 'once',
          taskRevisionId,
        })
      ).data.code,
    ).toBe('approval_required')
    const approve = {
      expectedVersion: campaign.version,
      idempotencyKey: 'approve',
      bundleHash: campaign.bundleHash,
      scope: {
        kind: 'execution',
        taskRevisionId,
        dispatchKey: 'once',
        artifactVersionIds: [],
        currency: 'USD',
        maxCost: 0,
        expiresAt: Date.now() + 60_000,
      },
    }
    expect((await call(`${path}/approve`, approve)).status).toBe(403)
    result = await call(`${path}/approve`, approve, true)
    expect(result.status).toBe(200)
    const firstVerifiedAt = result.data.campaign.approvals[0]!.reviewedAt
    now += 1000
    const replay = await call(`${path}/approve`, approve, 'replay')
    expect(replay.status).toBe(200)
    expect(replay.data.campaign.approvals[0]!.reviewedAt).toBe(firstVerifiedAt)
    campaign = result.data.campaign
    result = await call(`${path}/synthetic`, {
      expectedVersion: campaign.version,
      dispatchKey: 'once',
      taskRevisionId,
      approvalId: campaign.approvals[0]!.id,
    })
    expect(result.status).toBe(200)
    campaign = result.data.campaign
    campaign = installSupportedReviewFixture(store, campaign)
    const artifactVersionIds = [campaign.artifactVersions[0]!.id]
    result = await call(
      `${path}/approve`,
      {
        expectedVersion: campaign.version,
        idempotencyKey: 'approve-release',
        bundleHash: campaign.bundleHash,
        scope: {
          kind: 'release',
          artifactVersionIds,
          currency: 'USD',
          maxCost: 0,
          expiresAt: Date.now() + 60_000,
        },
      },
      true,
    )
    expect(result.status).toBe(200)
    campaign = result.data.campaign
    result = await call(`${path}/release`, {
      expectedVersion: campaign.version,
      idempotencyKey: 'release',
      approvalId: campaign.approvals.at(-1)!.id,
      artifactVersionIds,
    })
    expect(result.status).toBe(200)
    expect(result.data.campaign.status).toBe('completed')
    // Revoke a fresh protocol approval and retry the exact signed request at a later verifier time.
    campaign = result.data.campaign
    result = await call(
      `${path}/approve`,
      {
        expectedVersion: campaign.version,
        idempotencyKey: 'protocol-approval',
        bundleHash: campaign.bundleHash,
        scope: {
          kind: 'protocol',
          artifactVersionIds: [],
          currency: 'USD',
          maxCost: 0,
          expiresAt: Date.now() + 60_000,
        },
      },
      true,
    )
    campaign = result.data.campaign
    const revoke = {
      expectedVersion: campaign.version,
      idempotencyKey: 'revoke',
      approvalId: campaign.approvals.at(-1)!.id,
    }
    result = await call(`${path}/revoke`, revoke, true)
    expect(result.status).toBe(200)
    const revokedAt = result.data.campaign.approvals.at(-1)!.revokedAt
    now += 1000
    const revokedReplay = await call(`${path}/revoke`, revoke, 'replay')
    expect(revokedReplay.status).toBe(200)
    expect(revokedReplay.data.campaign.approvals.at(-1)!.revokedAt).toBe(revokedAt)
    campaign = revokedReplay.data.campaign
    const reference = {
      schema: 'labelset-reference-v1',
      id: '123e4567-e89b-42d3-a456-426614174000',
      version: 1,
      contentHash: `sha256:${'a'.repeat(64)}`,
      datasetSnapshotHash: `sha256:${'b'.repeat(64)}`,
      annotationSchemaHash: `sha256:${'c'.repeat(64)}`,
      aggregate: { subjects: 2, observations: 3, classes: { negative: 1, positive: 2 } },
      issuer: 'fixture',
      issuedAt: Date.now(),
    }
    result = await call(
      `${path}/labelsets`,
      { expectedVersion: campaign.version, idempotencyKey: 'labels1', reference },
      true,
    )
    expect(result.status).toBe(200)
    campaign = result.data.campaign
    for (const taskId of ['label-bound', 'unrelated']) {
      result = await call(`${path}/proposals`, {
        expectedVersion: campaign.version,
        idempotencyKey: taskId,
        command: {
          kind: 'declareSyntheticTask',
          taskId,
          inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
          artifactVersionIds: [],
          ...(taskId === 'label-bound' ? { labelSetContentHashes: [reference.contentHash] } : {}),
        },
      })
      campaign = result.data.campaign
    }
    result = await call(
      `${path}/labelsets`,
      {
        expectedVersion: campaign.version,
        idempotencyKey: 'labels2',
        reference: {
          ...reference,
          version: 2,
          previousContentHash: reference.contentHash,
          contentHash: `sha256:${'d'.repeat(64)}`,
        },
      },
      true,
    )
    expect(result.status).toBe(200)
    expect(result.data.campaign.taskRevisions.find((t) => t.taskId === 'label-bound')!.status).toBe(
      'stale',
    )
    expect(result.data.campaign.taskRevisions.find((t) => t.taskId === 'unrelated')!.status).toBe(
      'pending',
    )
    expect(result.data.campaign.labelSets).toHaveLength(2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
