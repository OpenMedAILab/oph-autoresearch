import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  FormalExecutionJobSpec,
  FormalExecutionPlan,
  ResearchCampaign,
} from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import {
  FormalExecutionController,
  type FormalExecutionRoute,
  type FormalExecutionScope,
} from './formal-execution-controller.ts'
import type { DurableJob } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const hash = (value: string | Uint8Array) => sha256(value)
const epoch = 'fixture_epoch_0123456789'
const connectionHash = hash('fixture-connection')
const bindingHash = hash('fixture-workspace-binding')
const evidenceHash = hash('fixture-admission')
const code = new TextEncoder().encode('print("formal")\n')
const candidateReceipt = new TextEncoder().encode('{"candidate":"fixture"}')
const receipt = new TextEncoder().encode('{"schema":"research-formal-oci-receipt-v1","ok":true}')

class FixtureAuthority {
  submitted = 0
  staged = 0
  queried = 0
  cancelled = 0
  completeOnQuery = 2
  throwAfterSubmit = false
  acceptReceipt = true
  queryFailures = 0
  mismatchTerminalSpec = false
  current: DurableJob | null = null
  async identity() {
    return { schema: 'research-authority-identity-v1' as const, epoch }
  }
  async registerCandidate(input: {
    code: Uint8Array
    candidateReceipt: Uint8Array
    expectedEpoch: string
  }) {
    expect(input.expectedEpoch).toBe(epoch)
    expect(hash(input.code)).toBe(hash(code))
    expect(hash(input.candidateReceipt)).toBe(hash(candidateReceipt))
    this.staged++
  }
  async submit(spec: FormalExecutionJobSpec, expectedEpoch: string) {
    expect(expectedEpoch).toBe(epoch)
    this.submitted++
    this.current = {
      spec,
      specHash: hash(canonicalJson(spec)),
      status: 'queued',
      outputPath: null,
      contentHash: null,
      error: null,
    }
    if (this.throwAfterSubmit) throw new Error('lost submit response')
    return this.current
  }
  async query(key: string, expectedEpoch: string): Promise<DurableJob | null> {
    expect(expectedEpoch).toBe(epoch)
    if (this.queryFailures > 0) {
      this.queryFailures--
      throw new Error('temporary authority network failure')
    }
    if (!this.current || this.current.spec.dispatchKey !== key) return null
    this.queried++
    if (this.mismatchTerminalSpec)
      return {
        ...this.current,
        specHash: hash('wrong-formal-spec'),
        status: 'failed' as const,
        error: 'wrong job',
      }
    if (this.queried >= this.completeOnQuery && this.current.status === 'queued')
      this.current = { ...this.current, status: 'completed', contentHash: hash(receipt) }
    return this.current
  }
  async cancel(key: string, expectedEpoch: string) {
    expect(expectedEpoch).toBe(epoch)
    this.cancelled++
    if (this.current?.spec.dispatchKey === key)
      this.current = { ...this.current, status: 'cancelled' }
    return this.current
  }
  async receipt() {
    return receipt
  }
  async reconcileInterrupted() {
    return this.current ? [this.current] : []
  }
  async verifyReceipt(_spec: FormalExecutionJobSpec, bytes: Uint8Array) {
    return this.acceptReceipt && hash(bytes) === hash(receipt)
  }
}

function route(authority: FixtureAuthority): FormalExecutionRoute {
  return {
    id: 'formal-route',
    profileId: 'fixture-profile',
    workspaceBindingHash: bindingHash,
    connectionHash,
    remoteRoot: '/srv/formal',
    authorityId: 'fixture-authority',
    admissionEvidenceHash: evidenceHash,
    admission: {
      schema: 'formal-rootless-oci-admission-v1',
      rootlessCgroupV2: true,
      evidenceHash,
    },
    maxCost: 0,
    authority,
  }
}

function plan(taskRevisionId: string): FormalExecutionPlan {
  return {
    schema: 'research-formal-plan-v1',
    planId: 'formal-plan',
    taskRevisionId,
    candidateArtifactId: 'candidate-artifact',
    codeHash: hash(code),
    candidateReceiptHash: hash(candidateReceipt),
    workspaceBindingHash: bindingHash,
    ociImageDigest: hash('image'),
    entryArgv: ['python3', 'main.py'],
    dataManifestHash: hash('manifest'),
    labelSetContentHash: hash('labels'),
    trustedEvaluatorId: 'binary-classification-v1',
    trustedEvaluatorHash: hash('evaluator'),
    resources: { maxRuntimeMs: 2_000, cpu: 1, memoryMb: 128, pidsLimit: 16, network: 'disabled' },
    datasetMount: { target: '/dataset', readOnly: true },
    outputMount: { target: '/out' },
  }
}

/** Seeds a Store snapshot with a plan already frozen by the preceding review workflow.
 * The controller still performs all subsequent reserve/claim/bind/observer mutations through Store. */
function seed(store: Store, root: string) {
  const workspace = upsertWorkspace(store, root, 'formal-controller')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fixture',
    model: 'fixture',
  })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'create',
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'formal controller',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 1 },
  })
  if (!created.ok) throw new Error(created.message)
  const taskRevisionId = 'task-revision'
  const frozen = plan(taskRevisionId)
  const planHash = hash(canonicalJson(frozen))
  const campaign: ResearchCampaign = {
    ...created.campaign,
    taskRevisions: [
      {
        id: taskRevisionId,
        revision: 1,
        taskId: 'task',
        stage: 'execution',
        templateId: 'synthetic-summary-v1',
        inputHash: hash('task'),
        outputContract: 'synthetic-summary-v1',
        dataClass: 'synthetic',
        status: 'verified',
        createdAt: Date.now(),
      },
    ],
    artifactVersions: [
      {
        id: 'candidate-artifact',
        artifactId: 'candidate-artifact',
        version: 1,
        uri: 'file:///fixture/candidate.json',
        kind: 'cli_preparation_candidate',
        contentHash: hash(candidateReceipt),
        createdAt: Date.now(),
        mediaType: 'application/json',
        dataClass: 'restricted-reference',
        schemaId: 'research-cli-preparation-candidate-v1',
        producerTaskRevisionId: taskRevisionId,
      },
    ],
    formalExecutionPlans: [frozen],
    formalExecutionDispatches: [],
    approvals: [
      {
        id: 'execution-approval',
        bundleHash: created.campaign.bundleHash,
        reviewerId: 'human',
        reviewerProofId: 'proof',
        reviewedAt: Date.now(),
        status: 'active',
        revokedAt: null,
        revokedByReviewerId: null,
        invalidatedAt: null,
        scope: {
          kind: 'formal_execution',
          formalPlanHash: planHash,
          formalEvaluatorId: frozen.trustedEvaluatorId,
          formalResources: frozen.resources,
          artifactVersionIds: ['candidate-artifact'],
          maxCost: 1,
          currency: 'USD',
          expiresAt: Date.now() + 60_000,
        },
      },
    ],
  }
  store.db
    .query('UPDATE research_campaigns SET snapshot = ?, version = ? WHERE id = ?')
    .run(JSON.stringify(campaign), campaign.version, campaign.id)
  return { workspace, campaign, frozen }
}

async function eventually<T>(read: () => T | undefined) {
  for (let i = 0; i < 300; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(5)
  }
  throw new Error('fixture did not settle')
}

test('formal controller persists a frozen v4 attempt, polls to receipt, and never rebuilds a lost response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-controller-'))
  const store = new Store({ path: ':memory:' })
  const authority = new FixtureAuthority()
  authority.throwAfterSubmit = true
  authority.queryFailures = 1
  const seeded = seed(store, root)
  const scope: FormalExecutionScope = {
    workspaceId: seeded.workspace.id,
    workspaceRoot: root,
    campaignId: seeded.campaign.id,
  }
  const controller = new FormalExecutionController(
    store,
    [route(authority)],
    {
      async read() {
        return { code, candidateReceipt }
      },
    },
    () => {},
    async () => ({
      profileId: 'fixture-profile',
      workspaceBindingHash: bindingHash,
      connectionHash,
      remoteRoot: '/srv/formal',
    }),
    'fixture-observer',
    5,
  )
  try {
    const first = await controller.submit(scope, {
      planId: seeded.frozen.planId,
      approvalId: 'execution-approval',
      routeId: 'formal-route',
      expectedVersion: seeded.campaign.version,
      idempotencyKey: 'formal-submit:formal-plan',
    })
    const replay = await controller.submit(scope, {
      planId: seeded.frozen.planId,
      approvalId: 'execution-approval',
      routeId: 'formal-route',
      expectedVersion: seeded.campaign.version,
      idempotencyKey: 'formal-submit:formal-plan',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.attemptId).toBe(first.attemptId)
    const completed = await eventually(() => {
      const attempt = getResearchCampaign(store, seeded.campaign.id)?.attempts.find(
        (item) => item.id === first.attemptId,
      )
      return attempt?.status === 'completed' ? attempt : undefined
    })
    expect(authority.submitted).toBe(1)
    expect(authority.staged).toBe(1)
    const campaign = getResearchCampaign(store, seeded.campaign.id)!
    const artifact = campaign.artifactVersions.find(
      (item) => item.id === completed.artifactVersionId,
    )!
    expect(artifact.uri.startsWith('file://')).toBe(true)
    expect(hash(await readFile(new URL(artifact.uri)))).toBe(hash(receipt))
    expect(artifact.validation).toMatchObject({
      schema: 'research-formal-oci-completion-v1',
      inputHash: campaign.taskRevisions[0]!.inputHash,
      contentHash: artifact.contentHash,
      formalPlanHash: hash(canonicalJson(seeded.frozen)),
    })
  } finally {
    controller.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('formal controller cancels at the authority and route drift stages zero bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-controller-'))
  const store = new Store({ path: ':memory:' })
  const authority = new FixtureAuthority()
  authority.completeOnQuery = Number.MAX_SAFE_INTEGER
  const seeded = seed(store, root)
  const scope: FormalExecutionScope = {
    workspaceId: seeded.workspace.id,
    workspaceRoot: root,
    campaignId: seeded.campaign.id,
  }
  let drift = true
  const controller = new FormalExecutionController(
    store,
    [route(authority)],
    {
      async read() {
        return { code, candidateReceipt }
      },
    },
    () => {},
    async () => ({
      profileId: 'fixture-profile',
      workspaceBindingHash: bindingHash,
      connectionHash,
      remoteRoot: drift ? '/srv/drifted' : '/srv/formal',
    }),
    'fixture-observer-two',
    5,
  )
  try {
    await expect(
      controller.submit(scope, {
        planId: seeded.frozen.planId,
        approvalId: 'execution-approval',
        routeId: 'formal-route',
        expectedVersion: seeded.campaign.version,
        idempotencyKey: 'drift',
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(authority.staged).toBe(0)
    drift = false
    const submitted = await controller.submit(scope, {
      planId: seeded.frozen.planId,
      approvalId: 'execution-approval',
      routeId: 'formal-route',
      expectedVersion: seeded.campaign.version,
      idempotencyKey: 'submit',
    })
    await eventually(() => (authority.submitted === 1 ? 1 : undefined))
    await controller.cancel(scope, submitted.attemptId)
    await eventually(() =>
      getResearchCampaign(store, seeded.campaign.id)?.attempts.find(
        (item) => item.id === submitted.attemptId,
      )?.status === 'cancelled'
        ? 1
        : undefined,
    )
    expect(authority.cancelled).toBeGreaterThanOrEqual(1)
  } finally {
    controller.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a tampered formal receipt remains unknown and is never admitted as an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-controller-'))
  const store = new Store({ path: ':memory:' })
  const authority = new FixtureAuthority()
  authority.acceptReceipt = false
  const seeded = seed(store, root)
  const scope: FormalExecutionScope = {
    workspaceId: seeded.workspace.id,
    workspaceRoot: root,
    campaignId: seeded.campaign.id,
  }
  const controller = new FormalExecutionController(
    store,
    [route(authority)],
    {
      async read() {
        return { code, candidateReceipt }
      },
    },
    () => {},
    async () => ({
      profileId: 'fixture-profile',
      workspaceBindingHash: bindingHash,
      connectionHash,
      remoteRoot: '/srv/formal',
    }),
    'fixture-observer-three',
    5,
  )
  try {
    const submitted = await controller.submit(scope, {
      planId: seeded.frozen.planId,
      approvalId: 'execution-approval',
      routeId: 'formal-route',
      expectedVersion: seeded.campaign.version,
      idempotencyKey: 'tamper',
    })
    await eventually(() =>
      getResearchCampaign(store, seeded.campaign.id)?.attempts.find(
        (item) => item.id === submitted.attemptId,
      )?.status === 'unknown'
        ? 1
        : undefined,
    )
    const campaign = getResearchCampaign(store, seeded.campaign.id)!
    expect(campaign.artifactVersions.some((item) => item.kind === 'formal_execution_receipt')).toBe(
      false,
    )
  } finally {
    controller.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a terminal response for a different frozen spec remains unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-formal-controller-'))
  const store = new Store({ path: ':memory:' })
  const authority = new FixtureAuthority()
  authority.mismatchTerminalSpec = true
  const seeded = seed(store, root)
  const scope: FormalExecutionScope = {
    workspaceId: seeded.workspace.id,
    workspaceRoot: root,
    campaignId: seeded.campaign.id,
  }
  const controller = new FormalExecutionController(
    store,
    [route(authority)],
    {
      async read() {
        return { code, candidateReceipt }
      },
    },
    () => {},
    async () => ({
      profileId: 'fixture-profile',
      workspaceBindingHash: bindingHash,
      connectionHash,
      remoteRoot: '/srv/formal',
    }),
    'fixture-observer-four',
    5,
  )
  try {
    const submitted = await controller.submit(scope, {
      planId: seeded.frozen.planId,
      approvalId: 'execution-approval',
      routeId: 'formal-route',
      expectedVersion: seeded.campaign.version,
      idempotencyKey: 'wrong-terminal',
    })
    await eventually(() =>
      getResearchCampaign(store, seeded.campaign.id)?.attempts.find(
        (item) => item.id === submitted.attemptId,
      )?.status === 'unknown'
        ? 1
        : undefined,
    )
    expect(
      getResearchCampaign(store, seeded.campaign.id)?.formalExecutionDispatches?.[0]?.status,
    ).toBe('unknown')
  } finally {
    controller.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
