import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindWorkspaceServer,
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { candidateReceipt } from '../research/cli-preparation-candidate.ts'
import {
  CliPreparationController,
  type CliPreparationRoute,
} from '../research/cli-preparation-controller.ts'
import type { CliPreparationJobSpec } from '../research/cli-preparation-job.ts'
import { canonicalJson, sha256 } from '../research/skill-lock.ts'
import { handleApi } from './index.ts'
import type { ApiDeps } from './types.ts'

const hash = (value: string) => sha256(value)

class Authority {
  readonly backendPolicyHash = hash('backend')
  readonly epoch = 'fixture_epoch_0001'
  current: {
    spec: CliPreparationJobSpec
    specHash: string
    status: 'queued' | 'completed'
    outputPath: null
    contentHash: null
    error: null
  } | null = null
  bytes = new Uint8Array()
  identity() {
    return { schema: 'research-authority-identity-v1' as const, epoch: this.epoch }
  }
  closeUnstarted({
    expectedEpoch,
  }: {
    expectedEpoch: string
    dispatchKey: string
    specHash: string
  }) {
    if (expectedEpoch !== this.epoch) throw new Error('wrong epoch')
    return { outcome: 'closed' }
  }
  submit(spec: CliPreparationJobSpec, expectedEpoch: string) {
    if (expectedEpoch !== this.epoch) throw new Error('wrong epoch')
    this.current = {
      spec,
      specHash: hash(canonicalJson(spec)),
      status: 'queued',
      outputPath: null,
      contentHash: null,
      error: null,
    }
    return this.current
  }
  query(key: string, expectedEpoch: string) {
    if (expectedEpoch !== this.epoch) throw new Error('wrong epoch')
    return this.current?.spec.dispatchKey === key ? this.current : null
  }
  cancel(_key: string, expectedEpoch: string) {
    if (expectedEpoch !== this.epoch) throw new Error('wrong epoch')
    return this.current
  }
  async receipt(_key: string, expectedEpoch: string) {
    if (expectedEpoch !== this.epoch) throw new Error('wrong epoch')
    return this.bytes
  }
}

function route(authority: Authority): CliPreparationRoute {
  return {
    id: 'route',
    label: 'route',
    deviceId: 'device',
    adapterId: 'adapter',
    model: 'model',
    adapterConfigHash: hash('adapter'),
    authority,
  }
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(5)
  }
  throw new Error('fixture did not settle')
}

function deps(
  store: Store,
  root: string,
  reviewer: NonNullable<ApiDeps['researchFormalCodeReviewer']>,
  drift = false,
): ApiDeps {
  const workspace = upsertWorkspace(store, root, 'formal')
  const binding = {
    version: 1 as const,
    profileId: 'fixture',
    remoteRoot: '/remote/formal',
    connectionHash: hash('ssh'),
    verifiedAt: 1,
  }
  bindWorkspaceServer(store, workspace.id, binding)
  return {
    store,
    config: {} as ApiDeps['config'],
    runs: {} as ApiDeps['runs'],
    bus: { publish() {} } as unknown as ApiDeps['bus'],
    pairing: {} as ApiDeps['pairing'],
    token: '',
    port: 0,
    enableLan: () => ({ port: 0 }),
    disableLan() {},
    lanEnabled: () => false,
    lanPort: () => 0,
    watchGit() {},
    startRun() {},
    researchFormalCodeReviewer: reviewer,
    researchFormalEvaluators: [
      { id: 'binary-classification-v1', implementationHash: hash('evaluator') },
    ],
    researchFormalCatalog: {
      images: [{ label: 'fixture image', digest: hash('oci') }],
      datasets: [
        {
          label: 'fixture dataset',
          dataManifestHash: hash('manifest'),
          labelSetContentHash: hash('labels'),
        },
      ],
      evaluators: [
        {
          id: 'binary-classification-v1',
          label: 'fixture evaluator',
          implementationHash: hash('evaluator'),
        },
      ],
    },
    resolveFormalWorkspaceBinding: async () => ({
      binding,
      profile: { root: drift ? '/remote/drifted' : binding.remoteRoot },
    }),
  }
}

async function post(
  d: ApiDeps,
  workspaceId: string,
  campaignId: string,
  action: string,
  body: unknown,
) {
  const url = `http://localhost/api/research/campaigns/${campaignId}/formal-execution/${action}?ws=${workspaceId}`
  return (await handleApi(
    new URL(url),
    new Request(url, { method: 'POST', body: JSON.stringify(body) }),
    d,
  ))!
}

test('formal review reserves before provider, replays safely, and binds the accepted exact plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-review-'))
  const store = new Store({ path: ':memory:' })
  const authority = new Authority()
  let providerCalls = 0
  let unblock!: () => void
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const reviewer = {
    quote: () => ({
      configHash: hash('formal-config'),
      reservedCost: 1,
      maxInputCharacters: 4096,
      maxOutputTokens: 64,
    }),
    async review() {
      providerCalls++
      await blocked
      return {
        reviewerId: 'fake',
        decision: 'accepted' as const,
        findings: [],
        runnerReceiptHash: hash('receipt'),
        actualCost: 0.25,
      }
    },
  }
  const d = deps(store, root, reviewer)
  const workspace = upsertWorkspace(store, root, 'formal')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'create',
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'formal',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 5 },
  })
  if (!created.ok) throw new Error(created.message)
  const labelHash = hash('labels')
  const labels = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: created.campaign.version,
    idempotencyKey: 'labels',
    command: {
      kind: 'recordLabelSet',
      reference: {
        schema: 'labelset-reference-v1',
        id: '123e4567-e89b-42d3-a456-426614174000',
        version: 1,
        contentHash: labelHash,
        datasetSnapshotHash: hash('dataset'),
        annotationSchemaHash: hash('schema'),
        aggregate: { subjects: 1, observations: 1, classes: { positive: 1 } },
        issuer: 'fixture',
        issuedAt: 1,
      },
      reviewer: { reviewerId: 'human', proofId: 'labels', verifiedAt: Date.now() },
    },
  })
  if (!labels.ok) throw new Error(labels.message)
  const task = mutateResearchCampaign(store, created.campaign.id, {
    expectedVersion: labels.campaign.version,
    idempotencyKey: 'task',
    command: {
      kind: 'declareSyntheticTask',
      taskId: 'task',
      inputHash: hash('input'),
      artifactVersionIds: [],
      labelSetContentHashes: [labelHash],
    },
  })
  if (!task.ok) throw new Error(task.message)
  const controller = new CliPreparationController(store, [route(authority)], () => {})
  try {
    const scope = {
      workspaceId: workspace.id,
      workspaceRoot: root,
      campaignId: created.campaign.id,
    }
    const proposed = controller.propose(scope, {
      expectedVersion: task.campaign.version,
      idempotencyKey: 'proposal',
      routeId: 'route',
      taskRevisionId: task.campaign.taskRevisions[0]!.id,
      instructions: 'code',
      maxRuntimeMs: 1000,
      maxCost: 1,
      acknowledgeUnknownCost: true,
    })
    const approvedPrep = mutateResearchCampaign(store, created.campaign.id, {
      expectedVersion: proposed.campaign.version,
      idempotencyKey: 'prep-approval',
      command: {
        kind: 'approve',
        approvalId: 'prep',
        bundleHash: proposed.campaign.bundleHash,
        scope: controller.approval(scope, proposed.preparationId).scope,
        reviewer: { reviewerId: 'human', proofId: 'prep', verifiedAt: Date.now() },
      },
    })
    if (!approvedPrep.ok) throw new Error(approvedPrep.message)
    await controller.submit(scope, {
      preparationId: proposed.preparationId,
      approvalId: 'prep',
      expectedVersion: approvedPrep.campaign.version,
    })
    const spec = (await eventually(() => authority.current))!.spec
    const draft = {
      schema: 'research-cli-preparation-draft-v1' as const,
      taskRevisionId: spec.taskRevisionId,
      specHash: hash('draft'),
      adapter: { id: 'adapter', model: 'model', identity: 'fixture' },
      inputHash: hash('draft'),
      configHash: hash('adapter'),
      contentHash: hash(JSON.stringify({ code: 'print(1)\n', patch: null })),
      code: 'print(1)\n',
      patch: null,
      usage: null,
      humanApprovalRequired: true as const,
    }
    authority.bytes = Buffer.from(JSON.stringify(candidateReceipt(spec, draft)))
    authority.current = { ...authority.current!, status: 'completed' }
    const campaign = await eventually(() => {
      const current = getResearchCampaign(store, created.campaign.id)
      return current?.cliPreparations?.[0]?.status === 'candidate' ? current : undefined
    })
    const base = {
      planId: 'plan',
      preparationId: proposed.preparationId,
      ociImageDigest: hash('oci'),
      dataManifestHash: hash('manifest'),
      labelSetContentHash: labelHash,
      trustedEvaluatorId: 'binary-classification-v1',
      trustedEvaluatorHash: hash('evaluator'),
      maxRuntimeMs: 1000,
      cpu: 1,
      memoryMb: 128,
      pidsLimit: 10,
    }
    const unsigned = await post(d, workspace.id, campaign.id, 'review', {
      ...base,
      approvalId: 'missing',
      expectedVersion: campaign.version,
      idempotencyKey: 'same',
    })
    expect(unsigned.status).toBe(400)
    expect(providerCalls).toBe(0)
    const quoted = await post(d, workspace.id, campaign.id, 'quote', {
      ...base,
      expiresAt: Date.now() + 60_000,
    })
    expect(quoted.status).toBe(200)
    const quote = (await quoted.json()) as {
      reviewApprovalScope: unknown
      plan: { codeHash: string }
    }
    expect(quote.plan.codeHash).toBe(hash(draft.code))
    expect(quote.plan.codeHash).not.toBe(draft.contentHash)
    const current = getResearchCampaign(store, campaign.id)!
    const approval = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: current.version,
      idempotencyKey: 'formal-approval',
      command: {
        kind: 'approve',
        approvalId: 'formal',
        bundleHash: current.bundleHash,
        scope: quote.reviewApprovalScope as never,
        reviewer: { reviewerId: 'human', proofId: 'formal', verifiedAt: Date.now() },
      },
    })
    if (!approval.ok) throw new Error(approval.message)
    const request = {
      ...base,
      approvalId: 'formal',
      expectedVersion: approval.campaign.version,
      idempotencyKey: 'same',
    }
    const first = post(d, workspace.id, campaign.id, 'review', request)
    await eventually(() => (providerCalls === 1 ? providerCalls : undefined))
    const second = await post(d, workspace.id, campaign.id, 'review', request)
    expect(second.status).toBe(202)
    expect(providerCalls).toBe(1)
    unblock()
    const finishedResponse = await first
    if (finishedResponse.status !== 200)
      throw new Error(
        JSON.stringify({
          response: await finishedResponse.json(),
          campaign: getResearchCampaign(store, campaign.id),
        }),
      )
    expect(getResearchCampaign(store, campaign.id)?.formalReviewDispatches?.[0]?.actualCost).toBe(
      0.25,
    )
    const accepted = getResearchCampaign(store, campaign.id)!
    const executionQuote = await post(d, workspace.id, campaign.id, 'approval', {
      ...base,
      executionMaxCost: 0,
      expiresAt: Date.now() + 60_000,
    })
    expect(executionQuote.status).toBe(200)
    const executionScope = (await executionQuote.json()) as {
      formalExecutionApprovalScope: unknown
    }
    const executionApproval = mutateResearchCampaign(store, campaign.id, {
      expectedVersion: accepted.version,
      idempotencyKey: 'execution-approval',
      command: {
        kind: 'approve',
        approvalId: 'execution',
        bundleHash: accepted.bundleHash,
        scope: executionScope.formalExecutionApprovalScope as never,
        reviewer: { reviewerId: 'human', proofId: 'execution', verifiedAt: Date.now() },
      },
    })
    if (!executionApproval.ok) throw new Error(executionApproval.message)
    const freeze = await post(d, workspace.id, campaign.id, 'freeze', {
      ...base,
      approvalId: 'execution',
      expectedVersion: executionApproval.campaign.version,
      idempotencyKey: 'freeze',
    })
    expect(freeze.status).toBe(200)
    const changed = await post(d, workspace.id, campaign.id, 'freeze', {
      ...base,
      cpu: 2,
      approvalId: 'execution',
      expectedVersion: executionApproval.campaign.version,
      idempotencyKey: 'changed',
    })
    expect(changed.status).toBe(400)
    d.resolveFormalWorkspaceBinding = async (bound) => ({
      binding: bound.serverBinding!,
      profile: { root: '/remote/drifted' },
    })
    const drift = await post(d, workspace.id, campaign.id, 'quote', {
      ...base,
      expiresAt: Date.now() + 60_000,
    })
    expect(drift.status).toBe(409)
  } finally {
    controller.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
