import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import {
  ResearchDocumentError,
  readResearchDocuments,
  writeResearchDocument,
} from './research-documents.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const roots: string[] = []
const stores: Store[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function study(previousVersion: string | null, citation = 'citation-1') {
  return {
    question: 'Does a fixed synthetic endpoint remain stable?',
    PICO: { population: 'synthetic phantom', intervention: 'fixed protocol' },
    evidenceCitations: [citation],
    counterEvidence: ['The evidence is synthetic and cannot establish clinical utility.'],
    protocol: { version: 1, blinded: true },
    endpoints: ['aggregate sensitivity'],
    splitPlan: { unit: 'patient', train: 0.7, validation: 0.1, test: 0.2 },
    codeVersion: 'c994218',
    previousVersion,
    ...(previousVersion ? { revision_note: 'Revised in response to independent review' } : {}),
  }
}

function setup() {
  const store = new Store({ path: ':memory:' })
  stores.push(store)
  return mkdtemp(join(tmpdir(), 'oph-documents-')).then((root) => {
    roots.push(root)
    const workspace = upsertWorkspace(store, root, 'documents')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const made = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'fixed evidence only',
      idempotencyKey: 'create-documents',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
    })
    if (!made.ok) throw new Error(made.message)
    const source = {
      id: 'citation-1',
      url: 'https://example.test/citation-1',
      title: 'Public metadata only',
      publishedAt: null,
      sourceKind: 'public-metadata' as const,
      retrievedAt: 1,
      contentHash: sha256('citation bytes'),
      locator: {
        schema: 'crossref-work-v1' as const,
        pointer: 'citation-1',
        endpoint: 'https://example.test',
      },
    }
    const citation = {
      ...source,
      projectionHash: sha256(canonicalJson(source)),
      verification: 'retrieved-public-metadata' as const,
      fullText: false as const,
    }
    const recorded = mutateResearchCampaign(store, made.campaign.id, {
      expectedVersion: made.campaign.version,
      idempotencyKey: 'citation-1',
      command: { kind: 'recordLiteratureCitation', citation },
    })
    if (!recorded.ok) throw new Error(recorded.message)
    return { store, root, workspace, campaign: recorded.campaign }
  })
}

test('study documents are immutable, versioned, and replay before stale-version rejection', async () => {
  const { store, root, campaign } = await setup()
  const first = await writeResearchDocument({
    store,
    workspaceRoot: root,
    campaignId: campaign.id,
    expectedVersion: campaign.version,
    idempotencyKey: 'study-one',
    kind: 'study',
    document: study(null),
  })
  expect(first.contentHash).toMatch(/^sha256:/)
  const replay = await writeResearchDocument({
    store,
    workspaceRoot: root,
    campaignId: campaign.id,
    expectedVersion: campaign.version,
    idempotencyKey: 'study-one',
    kind: 'study',
    document: study(null),
  })
  expect(replay.replayed).toBe(true)
  expect(replay.campaign.version).toBe(first.campaign.version)
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: first.campaign.version,
      idempotencyKey: 'study-one',
      kind: 'study',
      document: study(first.contentHash),
    }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      idempotencyKey: 'study-old',
      kind: 'study',
      document: study(null),
    }),
  ).rejects.toMatchObject({ status: 409 })
  const second = await writeResearchDocument({
    store,
    workspaceRoot: root,
    campaignId: campaign.id,
    expectedVersion: first.campaign.version,
    idempotencyKey: 'study-two',
    kind: 'study',
    document: study(first.contentHash),
  })
  const documents = await readResearchDocuments(store, root, campaign.id)
  expect(second.campaign.version).toBe(first.campaign.version + 1)
  expect(documents).toMatchObject([
    { stale: true, verified: true },
    { stale: false, verified: true },
  ])
})

test('document validation rejects unknown citations, unsupported claims, and candidate promotion fields', async () => {
  const { store, root, campaign } = await setup()
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      idempotencyKey: 'bad-reference',
      kind: 'study',
      document: study(null, 'unknown'),
    }),
  ).rejects.toMatchObject({ status: 409 })
  const current = getResearchCampaign(store, campaign.id)!
  store.db.query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?').run(
    JSON.stringify({
      ...current,
      modelReviews: [
        {
          id: 'review-stale',
          dispatchKey: 'stale',
          approvalId: 'approval',
          evidencePackHash: sha256('evidence'),
          configHash: sha256('config'),
          artifactVersionIds: [],
          currency: 'USD',
          reservedCost: 1,
          maxRequests: 2,
          maxOutputTokens: 1024,
          requestCount: 1,
          ownerPid: 1,
          status: 'done',
          sourceValidity: 'stale',
          sourceContextHash: sha256('stale'),
        },
      ],
    }),
    campaign.id,
  )
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: current.version,
      idempotencyKey: 'stale-review',
      kind: 'manuscript',
      document: {
        text: 'A claim without a completed current review.',
        claims: [
          { claim: 'unsupported', artifactVersionIds: ['missing'], reviewId: 'review-stale' },
        ],
        journalRequirementsHash: sha256('journal'),
        previousVersion: null,
      },
    }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: current.version,
      idempotencyKey: 'candidate-promotion',
      kind: 'skillcandidate',
      document: {
        status: 'candidate-not-admitted',
        sourceHash: sha256('source'),
        evaluationArtifactVersionIds: ['missing'],
        previousVersion: null,
        executionEnabled: true,
      },
    }),
  ).rejects.toMatchObject({ status: 400 })
})

test('a review supports only its mapped claim and exact validated producer artifact', async () => {
  const { store, root, campaign } = await setup()
  const current = getResearchCampaign(store, campaign.id)!
  const inputHash = sha256('task input')
  const artifactHash = sha256('artifact bytes')
  const contextHash = sha256(
    canonicalJson({ policy: current.policy, inputs: current.inputs, budget: current.budget }),
  )
  const reviewContextHash = sha256(
    canonicalJson({ context: contextHash, literatureCitations: current.literatureCitations ?? [] }),
  )
  const task = {
    id: 'task-evidence',
    revision: 1,
    stage: 'execution',
    templateId: 'synthetic-summary-v1',
    inputHash,
    outputContract: 'synthetic-summary-v1',
    dataClass: 'synthetic',
    status: 'verified',
    createdAt: 1,
  }
  const artifact = {
    id: 'artifact-evidence',
    artifactId: 'task-evidence',
    version: 1,
    uri: 'file:///safe/evidence.json',
    kind: 'synthetic-summary-v1',
    contentHash: artifactHash,
    createdAt: 1,
    producerTaskRevisionId: task.id,
    producerAttemptId: 'attempt-evidence',
    validation: { inputHash, contentHash: artifactHash, byteLength: 1, verifiedAt: 1 },
  }
  store.db.query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?').run(
    JSON.stringify({
      ...current,
      taskRevisions: [task],
      artifactVersions: [artifact],
      attempts: [
        {
          id: 'attempt-evidence',
          taskRevisionId: task.id,
          dispatchKey: 'evidence',
          ownerPid: 1,
          status: 'completed',
          executionStartedAt: 1,
          endedAt: 1,
          artifactVersionId: artifact.id,
          error: null,
          cancelRequestedAt: null,
        },
      ],
      modelReviews: [
        {
          id: 'review-current',
          dispatchKey: 'review',
          approvalId: 'approval',
          evidencePackHash: sha256('pack'),
          configHash: sha256('config'),
          artifactVersionIds: [artifact.id],
          currency: 'USD',
          reservedCost: 1,
          maxRequests: 2,
          maxOutputTokens: 1024,
          requestCount: 1,
          ownerPid: 1,
          status: 'done',
          sourceValidity: 'current',
          sourceContextHash: reviewContextHash,
          text: JSON.stringify({
            decision: 'supported',
            claims: [{ claim: 'mapped claim', artifactVersionIds: [artifact.id] }],
            limitations: [],
          }),
        },
      ],
    }),
    campaign.id,
  )
  const saved = await writeResearchDocument({
    store,
    workspaceRoot: root,
    campaignId: campaign.id,
    expectedVersion: current.version,
    idempotencyKey: 'supported-map',
    kind: 'manuscript',
    document: {
      text: 'Only the mapped claim is saved.',
      journalRequirementsHash: sha256('journal'),
      previousVersion: null,
      claims: [
        { claim: 'mapped claim', artifactVersionIds: [artifact.id], reviewId: 'review-current' },
      ],
    },
  })
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: saved.campaign.version,
      idempotencyKey: 'unsupported-map',
      kind: 'manuscript',
      document: {
        text: 'Different prose cannot inherit support.',
        journalRequirementsHash: sha256('journal'),
        previousVersion: null,
        claims: [
          {
            claim: 'different claim',
            artifactVersionIds: [artifact.id],
            reviewId: 'review-current',
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ status: 409 })
  const tampered = getResearchCampaign(store, campaign.id)!
  store.db.query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?').run(
    JSON.stringify({
      ...tampered,
      artifactVersions: tampered.artifactVersions.map((candidate) =>
        candidate.id === artifact.id
          ? {
              ...candidate,
              validation: { ...artifact.validation, contentHash: sha256('tampered') },
            }
          : candidate,
      ),
    }),
    campaign.id,
  )
  const staleDocuments = await readResearchDocuments(store, root, campaign.id)
  expect(staleDocuments.find((document) => document.kind === 'manuscript')).toMatchObject({
    stale: true,
    verified: true,
  })
  await expect(
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign.id,
      expectedVersion: saved.campaign.version,
      idempotencyKey: 'bad-validation',
      kind: 'skillcandidate',
      document: {
        status: 'candidate-not-admitted',
        sourceHash: sha256('candidate'),
        evaluationArtifactVersionIds: [artifact.id],
        previousVersion: null,
      },
    }),
  ).rejects.toMatchObject({ status: 409 })
})

test('reads only verified contained document bytes and does not reveal a tampered file', async () => {
  const { store, root, campaign } = await setup()
  const result = await writeResearchDocument({
    store,
    workspaceRoot: root,
    campaignId: campaign.id,
    expectedVersion: campaign.version,
    idempotencyKey: 'study-tamper',
    kind: 'study',
    document: study(null),
  })
  const path = new URL(result.uri)
  await writeFile(path, '{"secret":"must not be returned"}')
  const read = await readResearchDocuments(store, root, campaign.id)
  expect(read[0]).toMatchObject({ verified: false, stale: true })
  expect(read[0]).not.toHaveProperty('document')
  expect((await readFile(path)).toString()).toContain('secret')
  const snapshot = getResearchCampaign(store, campaign.id)!
  store.db.query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?').run(
    JSON.stringify({
      ...snapshot,
      artifactVersions: snapshot.artifactVersions.map((artifact) =>
        artifact.id === snapshot.artifactVersions[0]?.id
          ? { ...artifact, uri: 'file:///etc/hosts' }
          : artifact,
      ),
    }),
    campaign.id,
  )
  const escaped = await readResearchDocuments(store, root, campaign.id)
  expect(escaped[0]).not.toHaveProperty('document')
})

test('non-document errors retain a useful typed status', () => {
  expect(new ResearchDocumentError('bad', 409)).toMatchObject({ status: 409 })
})
