import { afterEach, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  FormalExecutionJobSpec,
  FormalExecutionPlan,
  ResearchCampaign,
} from '@oph-autoresearch/core'
import {
  bindWorkspaceServer,
  createConversation,
  createResearchCampaign,
  Store,
  scientificContextHash,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { buildEvidencePack } from './evidence-session.ts'
import { formalWorkspaceBindingHash } from './formal-binding.ts'
import { formalExecutionPlanHash } from './formal-job.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-evidence-'))
  const store = new Store({ path: ':memory:' })
  cleanup.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const ws = upsertWorkspace(store, root, 'formal evidence')
  const binding = {
    version: 1 as const,
    profileId: 'fixture',
    remoteRoot: '/srv/research',
    connectionHash: sha256('connection'),
    verifiedAt: 1,
  }
  bindWorkspaceServer(store, ws.id, binding)
  const conversation = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fixture',
    model: 'fixture',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'create',
    workspaceId: ws.id,
    parentConversationId: conversation.id,
    goal: 'private canary',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 10 },
  })
  if (!created.ok) throw new Error(created.message)
  const plan: FormalExecutionPlan = {
    schema: 'research-formal-plan-v1',
    planId: 'plan',
    taskRevisionId: 'task',
    candidateArtifactId: 'candidate',
    codeHash: sha256('code'),
    candidateReceiptHash: sha256('candidate'),
    workspaceBindingHash: formalWorkspaceBindingHash(ws.id, binding),
    ociImageDigest: sha256('image'),
    entryArgv: ['python3', 'main.py'],
    dataManifestHash: sha256('data'),
    labelSetContentHash: sha256('labels'),
    trustedEvaluatorId: 'binary-classification-v1',
    trustedEvaluatorHash: sha256('evaluator'),
    resources: { maxRuntimeMs: 2000, cpu: 1, memoryMb: 128, pidsLimit: 16, network: 'disabled' },
    datasetMount: { target: '/dataset', readOnly: true },
    outputMount: { target: '/out' },
  }
  const planHash = formalExecutionPlanHash(plan)
  const epoch = 'fixture_epoch_0123456789'
  const spec: FormalExecutionJobSpec = {
    version: 4,
    campaignId: created.campaign.id,
    taskRevisionId: 'task',
    dispatchKey: 'attempt',
    formalPlan: plan,
    formalPlanHash: planHash,
    lease: { ownerId: 'owner', token: 'token', fence: 1, expiresAt: 1000 },
    execution: {
      adapter: 'formal-rootless-oci-v1',
      containerName: 'container',
      authorityEpoch: epoch,
    },
  }
  const specHash = sha256(canonicalJson(spec))
  const route = {
    routeId: 'route',
    profileId: binding.profileId,
    connectionHash: binding.connectionHash,
    remoteRoot: binding.remoteRoot,
    workspaceBindingHash: plan.workspaceBindingHash,
    authorityId: 'authority',
    admissionEvidenceHash: sha256('admission'),
  }
  const receipt = {
    schema: 'research-formal-oci-receipt-v1',
    planHash,
    codeHash: plan.codeHash,
    imageDigest: plan.ociImageDigest,
    dataManifestHash: plan.dataManifestHash,
    labelSetContentHash: plan.labelSetContentHash,
    evaluatorHash: plan.trustedEvaluatorHash,
    predictionHash: sha256('predictions'),
    metrics: { tp: 3, tn: 2, fp: 1, fn: 2, accuracy: 5 / 8, precision: 3 / 4, recall: 3 / 5 },
  }
  const path = join(root, '.oph', 'research', created.campaign.id, 'attempt', 'formal-receipt.json')
  await mkdir(dirname(path), { recursive: true })
  const campaign: ResearchCampaign = {
    ...created.campaign,
    labelSets: [
      {
        schema: 'labelset-reference-v1',
        id: 'labels',
        version: 1,
        contentHash: plan.labelSetContentHash,
        datasetSnapshotHash: plan.dataManifestHash,
        annotationSchemaHash: sha256('annotation'),
        aggregate: { subjects: 8, observations: 8, classes: { positive: 5, negative: 3 } },
        issuer: 'fixture',
        issuedAt: 1,
      },
    ],
    taskRevisions: [
      {
        id: 'task',
        revision: 1,
        stage: 'execution',
        templateId: 'synthetic-summary-v1',
        inputHash: sha256('task'),
        outputContract: 'synthetic-summary-v1',
        dataClass: 'synthetic',
        status: 'verified',
        sourceContextHash: scientificContextHash(created.campaign, 2),
        sourceContextVersion: 2,
        createdAt: 1,
      },
    ],
    attempts: [
      {
        id: 'attempt',
        taskRevisionId: 'task',
        dispatchKey: 'attempt',
        backend: 'ssh-daemon',
        ownerPid: 1,
        status: 'completed',
        executionStartedAt: 1,
        endedAt: 2,
        cancelRequestedAt: null,
        artifactVersionId: 'result',
        error: null,
        formalExecutionJobSpec: spec,
        formalExecutionJobSpecHash: specHash,
        formalExecutionAuthority: {
          schema: 'formal-execution-authority-binding-v1',
          ...route,
          epoch,
          jobSpecHash: specHash,
          dispatchState: 'acknowledged',
        },
      },
    ],
    formalExecutionPlans: [plan],
    formalExecutionDispatches: [
      {
        id: 'dispatch',
        planId: 'plan',
        planHash,
        attemptId: 'attempt',
        approvalId: 'approval',
        ...route,
        reservedMaxCost: 1,
        status: 'completed',
        receiptHash: '',
      },
    ],
    artifactVersions: [
      {
        id: 'result',
        artifactId: 'plan',
        version: 1,
        uri: pathToFileURL(path).toString(),
        kind: 'formal_execution_receipt',
        contentHash: '',
        createdAt: 2,
        producerAttemptId: 'attempt',
        producerTaskRevisionId: 'task',
        mediaType: 'application/json',
        schemaId: 'research-formal-oci-receipt-v1',
        dataClass: 'restricted-reference',
      },
    ],
  }
  campaign.artifactVersions.push({
    id: 'candidate',
    artifactId: 'candidate',
    version: 1,
    uri: 'file:///unused-candidate',
    kind: 'cli_preparation_candidate',
    contentHash: plan.candidateReceiptHash,
    createdAt: 1,
    producerTaskRevisionId: 'task',
  })
  function persist() {
    store.db
      .query('UPDATE research_campaigns SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(campaign), campaign.id)
  }
  async function write(value: unknown = receipt) {
    const bytes = JSON.stringify(value)
    await writeFile(path, bytes)
    campaign.artifactVersions[0]!.contentHash = sha256(bytes)
    campaign.formalExecutionDispatches![0]!.receiptHash = sha256(bytes)
    persist()
  }
  await write()
  return {
    root,
    path,
    campaign,
    receipt,
    plan,
    write,
    persist,
    pack: () => buildEvidencePack(store, root, campaign.id, ['attempt']),
    store,
  }
}

test('actual buildEvidencePack admits only exact current formal evidence and independently derives aggregate metrics', async () => {
  const f = await fixture()
  const pack = await f.pack()
  expect(pack.reports).toHaveLength(1)
  expect(pack.reports[0]).toMatchObject({
    templateId: 'formal-oci-v1',
    byteLength: Buffer.byteLength(JSON.stringify(f.receipt)),
    inputHash: formalExecutionPlanHash(f.plan),
    report: { schema: 'research-formal-evidence-v1', metrics: f.receipt.metrics },
  })
  expect(JSON.stringify(pack)).not.toContain('private canary')
  expect(JSON.stringify(pack)).not.toContain(f.root)
  expect(JSON.stringify(pack)).not.toContain('/srv/research')
  await expect(
    buildEvidencePack(f.store, dirname(f.root), f.campaign.id, ['attempt']),
  ).rejects.toThrow()
})

test('a recovered completed receipt remains reviewable after observation uncertainty', async () => {
  const f = await fixture()
  f.campaign.attempts[0]!.formalExecutionAuthority!.dispatchState = 'observation_unknown'
  f.persist()
  expect((await f.pack()).reports).toHaveLength(1)
})

const mutations: Array<[string, (campaign: ResearchCampaign) => void]> = [
  [
    'superseded plan labels',
    (c) => {
      c.labelSets!.push({ ...c.labelSets![0]!, version: 2, contentHash: sha256('updated labels') })
    },
  ],
  [
    'candidate changed',
    (c) => {
      c.artifactVersions[1]!.contentHash = sha256('changed candidate')
    },
  ],
  [
    'quarantined',
    (c) => {
      c.attempts[0]!.resultDisposition = 'quarantined'
    },
  ],
  [
    'cancel requested',
    (c) => {
      c.attempts[0]!.cancelRequestedAt = 2
    },
  ],
  [
    'unknown execution',
    (c) => {
      c.attempts[0]!.status = 'unknown'
    },
  ],
  [
    'wrong producer',
    (c) => {
      c.artifactVersions[0]!.producerAttemptId = 'other'
    },
  ],
  [
    'wrong task producer',
    (c) => {
      c.artifactVersions[0]!.producerTaskRevisionId = 'other'
    },
  ],
  [
    'forged job hash',
    (c) => {
      c.attempts[0]!.formalExecutionJobSpecHash = sha256('other')
    },
  ],
  [
    'different epoch',
    (c) => {
      c.attempts[0]!.formalExecutionAuthority!.epoch = 'different_epoch_123456'
    },
  ],
  [
    'different route',
    (c) => {
      c.formalExecutionDispatches![0]!.routeId = 'different'
    },
  ],
  [
    'incomplete dispatch',
    (c) => {
      c.formalExecutionDispatches![0]!.status = 'unknown'
    },
  ],
  [
    'different frozen resources',
    (c) => {
      c.formalExecutionPlans![0]!.resources.cpu = 2
    },
  ],
  [
    'scientific context changed',
    (c) => {
      c.goal = 'changed question'
    },
  ],
  [
    'successor task',
    (c) => {
      c.taskRevisions.push({
        ...c.taskRevisions[0]!,
        id: 'successor',
        revision: 2,
        previousRevisionId: 'task',
      })
    },
  ],
  [
    'missing input artifact',
    (c) => {
      c.taskRevisions[0]!.artifactVersionIds = ['missing']
    },
  ],
  [
    'missing label lineage',
    (c) => {
      c.taskRevisions[0]!.labelSetContentHashes = [sha256('missing')]
    },
  ],
  [
    'superseded artifact',
    (c) => {
      c.artifactVersions.push({ ...c.artifactVersions[0]!, id: 'new', version: 2 })
    },
  ],
]
for (const [name, mutate] of mutations)
  test(`evidence pack rejects ${name}`, async () => {
    const f = await fixture()
    mutate(f.campaign)
    f.persist()
    await expect(f.pack()).rejects.toThrow()
  })

for (const field of [
  'planHash',
  'codeHash',
  'imageDigest',
  'dataManifestHash',
  'labelSetContentHash',
  'evaluatorHash',
])
  test(`evidence pack rejects hash-consistent receipt with wrong ${field}`, async () => {
    const f = await fixture()
    await f.write({ ...f.receipt, [field]: sha256('wrong') })
    await expect(f.pack()).rejects.toThrow()
  })

for (const [name, metrics] of [
  ['forged accuracy', { tp: 3, tn: 2, fp: 1, fn: 2, accuracy: 1, precision: 0.75, recall: 0.6 }],
  ['negative counts', { tp: -1, tn: 2, fp: 1, fn: 2, accuracy: 0.5, precision: 0, recall: 0 }],
  ['empty sample', { tp: 0, tn: 0, fp: 0, fn: 0, accuracy: 0, precision: 0, recall: 0 }],
  [
    'overflow',
    { tp: Number.MAX_SAFE_INTEGER, tn: 1, fp: 1, fn: 2, accuracy: 1, precision: 1, recall: 1 },
  ],
])
  test(`evidence pack rejects ${name}`, async () => {
    const f = await fixture()
    await f.write({ ...f.receipt, metrics })
    await expect(f.pack()).rejects.toThrow()
  })

test('evidence pack rejects extra sensitive fields and altered bytes even when JSON remains valid', async () => {
  const f = await fixture()
  await f.write({ ...f.receipt, patientId: 'private-data' })
  await expect(f.pack()).rejects.toThrow()
  await f.write()
  await writeFile(f.path, JSON.stringify({ ...f.receipt, predictionHash: sha256('changed') }))
  await expect(f.pack()).rejects.toThrow('hash mismatch')
})

for (const attack of ['outside URI', 'file symlink', 'directory symlink', 'hardlink', 'oversized'])
  test(`evidence pack rejects ${attack}`, async () => {
    const f = await fixture()
    const other = join(f.root, 'other')
    if (attack === 'outside URI') {
      await writeFile(other, JSON.stringify(f.receipt))
      f.campaign.artifactVersions[0]!.uri = pathToFileURL(other).toString()
      f.persist()
    }
    if (attack === 'file symlink') {
      await rename(f.path, other)
      await symlink(other, f.path)
    }
    if (attack === 'directory symlink') {
      await rename(dirname(f.path), other)
      await symlink(other, dirname(f.path))
    }
    if (attack === 'hardlink') await link(f.path, other)
    if (attack === 'oversized') await truncate(f.path, 1_000_001)
    await expect(f.pack()).rejects.toThrow()
  })
