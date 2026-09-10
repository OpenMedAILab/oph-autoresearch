import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendStep,
  createConversation,
  createResearchCampaign,
  createRun,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import type { ApiRequestDeps } from '../api/types.ts'
import { assistantContext, researchPreset } from './research-assistant.ts'
import { readResearchDocuments, writeResearchDocument } from './research-documents.ts'
import { parseWorkflowReview } from './workflow-evidence.ts'

test('workflow review allows a preface but requires one complete unchanged terminal JSON result', () => {
  const review = {
    decision: 'supported' as const,
    claims: [{ claim: 'The result.', artifactVersionIds: ['artifact'] }],
    limitations: ['Limited.'],
  }
  const json = JSON.stringify(review)
  expect(parseWorkflowReview(`Independent review completed.\n\n${json}`, ['artifact'])).toEqual(
    review,
  )
  expect(() => parseWorkflowReview(`${json}\nMore prose`, ['artifact'])).toThrow()
  expect(() => parseWorkflowReview(`${json}\n${json}`, ['artifact'])).toThrow()
  expect(() => parseWorkflowReview(`Wrong {object}\n${json}`, ['artifact'])).toThrow()
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const work of cleanups.splice(0)) await work()
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oph-workflow-evidence-'))
  const store = new Store({ path: ':memory:' })
  cleanups.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const workspace = upsertWorkspace(store, root, 'fixture')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const made = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'Engineering evidence workflow',
    idempotencyKey: 'create',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!made.ok) throw new Error(made.message)
  const campaign = () => getResearchCampaign(store, made.campaign.id)!
  const write = (
    kind: Parameters<typeof writeResearchDocument>[0]['kind'],
    document: Record<string, unknown>,
  ) =>
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: campaign().id,
      expectedVersion: campaign().version,
      idempotencyKey: crypto.randomUUID(),
      kind,
      document,
    })
  const source = await write('evidence', {
    key: 'source',
    title: 'Fixture',
    url: 'https://example.org',
    retrievedAt: '2026-09-07',
    readingDepth: 'metadata',
    license: 'fixture',
    segments: [],
    previousVersion: null,
  })
  const study = await write('study', {
    question: 'Can the engineering workflow finish?',
    PICO: { population: 'synthetic fixture' },
    evidenceCitations: [source.contentHash],
    counterEvidence: ['Not clinical validation'],
    protocol: { budget: 'zero' },
    endpoints: ['completion'],
    splitPlan: { unit: 'patient' },
    codeVersion: 'fixture',
    previousVersion: null,
  })
  const studyArtifact = campaign().artifactVersions.find(
    (a) => a.contentHash === study.contentHash,
  )!
  const selection = mutateResearchCampaign(store, campaign().id, {
    expectedVersion: campaign().version,
    idempotencyKey: 'select',
    command: {
      kind: 'selectStudy',
      documentId: studyArtifact.id,
      contentHash: study.contentHash,
      requestId: 'fixture-selection',
      localRoot: root,
      serverBindingHash: null,
    },
  })
  if (!selection.ok) throw new Error(selection.message)
  const run = createRun(store, {
    conversationId: parent.id,
    workspaceId: workspace.id,
    model: 'test',
    clientRequestId: 'run',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const summary = {
    run_dir: '/fixture/run',
    pid: 12,
    exit_code: 0,
    metrics_summary: { successful_calls: 20 },
    clinical_validation: false,
  }
  const step = appendStep(store, {
    runId: run.id,
    seq: 1,
    kind: 'tool_action',
    toolName: 'ssh_run_command',
    status: 'success',
    payload: {
      kind: 'tool_result',
      args: { command: 'fixture audit' },
      outcome: {
        status: 'success',
        executed: true,
        message: 'ok',
        data: { exitCode: 0, timedOut: false, stdout: JSON.stringify(summary) },
      },
    },
  })
  const experiment = {
    key: 'run',
    studyHash: study.contentHash,
    executionChannel: 'ssh-engineering',
    sourceStepId: step.id,
    statusStepId: null,
    summary,
    limitations: ['Provenance is not clinical validity'],
    previousVersion: null,
  }
  const deps = {
    store,
    workspaceRoot: root,
    workspaceId: workspace.id,
  } as unknown as ApiRequestDeps
  return {
    root,
    store,
    workspace,
    parent,
    campaign,
    write,
    run,
    summary,
    step,
    experiment,
    deps,
    study,
  }
}
async function reviewFixture(
  f: Awaited<ReturnType<typeof setup>>,
  approve = true,
  indirect = false,
) {
  const saved = await f.write('experiment', f.experiment)
  const artifact = f.campaign().artifactVersions.find((a) => a.contentHash === saved.contentHash)!
  const child = createConversation(f.store, {
    workspaceId: f.workspace.id,
    parentConversationId: f.parent.id,
    provider: 'test',
    model: 'reviewer',
  })
  const map = {
    decision: 'supported',
    claims: [
      { claim: 'The fixture contains twenty completed calls.', artifactVersionIds: [artifact.id] },
    ],
    limitations: ['Engineering only'],
  }
  const startArgs = {
    goal: 'Independent review',
    nodes: [
      { id: 'review', agent: 'independent-reviewer', task: 'Review exact artifacts', needs: [] },
      ...(indirect
        ? [{ id: 'analysis', agent: 'results-analyst', task: 'Analyze', needs: ['review'] }]
        : []),
      {
        id: 'c',
        kind: 'checkpoint',
        label: 'Accept review',
        needs: [indirect ? 'analysis' : 'review'],
      },
    ],
    maxConcurrent: 1,
  }
  const initial = appendStep(f.store, {
    runId: f.run.id,
    seq: 2,
    kind: 'tool_action',
    toolName: 'workflow',
    status: 'running',
    payload: { kind: 'tool_call', args: startArgs },
  })
  settleToolStep(f.store, initial.id, 'success', {
    kind: 'tool_result',
    args: startArgs,
    outcome: {
      status: 'success',
      executed: true,
      message: 'waiting',
      data: {
        workflowId: initial.id,
        phase: 'waiting_review',
        checkpointId: 'c',
        receipts: [
          {
            nodeId: 'review',
            agent: 'independent-reviewer',
            label: 'Reviewer',
            status: 'done',
            output: JSON.stringify(map),
            durationMs: 10,
            conversationId: child.id,
          },
          ...(indirect
            ? [
                {
                  nodeId: 'analysis',
                  agent: 'results-analyst',
                  label: 'Analysis',
                  status: 'done',
                  output: 'Accept',
                  durationMs: 1,
                },
              ]
            : []),
        ],
      },
    },
  })
  if (approve)
    appendStep(f.store, {
      runId: f.run.id,
      seq: 3,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: {
          workflowId: initial.id,
          checkpointId: 'c',
          decision: 'approve',
          note: 'Evidence checked',
        },
        outcome: {
          status: 'success',
          executed: true,
          message: 'completed',
          data: {
            workflowId: initial.id,
            phase: 'completed',
            receipts: [],
            review: { checkpointId: 'c', decision: 'approve', note: 'Evidence checked' },
          },
        },
      },
    })
  const document = {
    key: 'results',
    studyHash: f.study.contentHash,
    experimentIds: [artifact.id],
    workflowId: initial.id,
    nodeId: 'review',
    review: map,
    previousVersion: null,
  }
  return { saved, artifact, document, map }
}

test('SSH receipt, completed independent review, writing and peer review form a versioned evidence chain', async () => {
  const f = await setup(),
    review = await reviewFixture(f)
  const context = await assistantContext(f.deps, [f.campaign()])
  expect(context.campaigns[0]?.experimentSources[0]?.sourceStepId).toBe(f.experiment.sourceStepId)
  const savedReview = await f.write('resultsreview', review.document)
  const reviewId = f
    .campaign()
    .artifactVersions.find((a) => a.contentHash === savedReview.contentHash)!.id
  expect((await researchPreset(f.deps, f.campaign(), 'writing')).workflow.nodes[0]?.id).toBe(
    'writing',
  )
  const manuscript = {
    text: '# Engineering report\nThe fixture contains twenty completed calls.',
    claims: [{ ...review.map.claims[0], reviewId }],
    journalRequirementsHash: `sha256:${'a'.repeat(64)}`,
    previousVersion: null,
  }
  const exactText = `${manuscript.text}\n\n中文正文，保留空行。\r\n`
  const path = join(f.root, 'draft.md')
  await writeFile(path, exactText)
  const fileHash = `sha256:${new Bun.CryptoHasher('sha256').update(exactText).digest('hex')}`
  const { text: _text, ...fields } = manuscript
  const fileDocument = { ...fields, textFile: { path: 'draft.md', sha256: fileHash } }
  await expect(f.write('manuscript', { ...fileDocument, text: exactText })).rejects.toThrow(
    'replaces text',
  )
  await expect(
    f.write('manuscript', { ...fileDocument, textFile: { path, sha256: fileHash } }),
  ).rejects.toThrow('invalid manuscript textFile')
  await expect(
    f.write('manuscript', {
      ...fileDocument,
      textFile: { path: 'draft.md', sha256: `sha256:${'0'.repeat(64)}` },
    }),
  ).rejects.toThrow('hash mismatch')
  await symlink(tmpdir(), join(f.root, 'outside'))
  await expect(
    f.write('manuscript', { ...fileDocument, textFile: { path: 'outside', sha256: fileHash } }),
  ).rejects.toThrow('inside the workspace')
  const draft = await f.write('manuscript', fileDocument)
  const stored = JSON.parse(await Bun.file(fileURLToPath(draft.uri)).text())
  expect(stored.document.text).toBe(exactText)
  expect(stored.document.textFile).toBeUndefined()
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).find(
      (d) => d.kind === 'manuscript',
    )?.stale,
  ).toBe(false)
  expect((await researchPreset(f.deps, f.campaign(), 'peerreview')).workflow.nodes).toHaveLength(4)
  await f.write('peerreview', {
    key: 'peer',
    manuscriptHash: draft.contentHash,
    reviews: [
      {
        role: 'methods',
        locator: 'Methods',
        priority: 'minor',
        comment: 'Describe fixture scope',
        suggestion: 'State engineering only',
      },
    ],
    revisionRound: 1,
    previousVersion: null,
  })
  await f.write('manuscript', {
    ...manuscript,
    text: `${manuscript.text}\nEngineering only.`,
    previousVersion: draft.contentHash,
  })
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).find(
      (d) => d.kind === 'peerreview',
    )?.stale,
  ).toBe(true)
})

test('fabricated or altered SSH receipts cannot be imported', async () => {
  const f = await setup()
  await expect(
    f.write('experiment', { ...f.experiment, sourceStepId: 'invented' }),
  ).rejects.toThrow('provenance')
  await expect(
    f.write('experiment', { ...f.experiment, summary: { ...f.summary, successful_calls: 99 } }),
  ).rejects.toThrow('provenance')
})

test('pending checkpoints and modified independent conclusions cannot authorize writing', async () => {
  const f = await setup(),
    review = await reviewFixture(f, false)
  await expect(f.write('resultsreview', review.document)).rejects.toThrow('provenance')
  await expect(researchPreset(f.deps, f.campaign(), 'writing')).rejects.toThrow('结果尚未独立复核')
  const g = await setup(),
    accepted = await reviewFixture(g)
  await expect(
    g.write('resultsreview', {
      ...accepted.document,
      review: { ...accepted.map, limitations: [] },
    }),
  ).rejects.toThrow('provenance')
})

test('unmapped manuscript claims are rejected and corrupted experiment files invalidate downstream writing', async () => {
  const f = await setup(),
    review = await reviewFixture(f)
  const saved = await f.write('resultsreview', review.document)
  const reviewId = f
    .campaign()
    .artifactVersions.find((a) => a.contentHash === saved.contentHash)!.id
  const manuscript = {
    text: 'Result',
    claims: [{ ...review.map.claims[0], reviewId }],
    journalRequirementsHash: `sha256:${'a'.repeat(64)}`,
    previousVersion: null,
  }
  await expect(
    f.write('manuscript', {
      ...manuscript,
      claims: [{ ...manuscript.claims[0], claim: 'Clinically effective' }],
    }),
  ).rejects.toThrow('unsupported manuscript claim')
  await f.write('manuscript', manuscript)
  await writeFile(fileURLToPath(review.saved.uri), 'corrupt')
  const docs = await readResearchDocuments(f.store, f.root, f.campaign().id)
  expect(docs.find((d) => d.kind === 'resultsreview')?.stale).toBe(true)
  expect(docs.find((d) => d.kind === 'manuscript')?.stale).toBe(true)
  await expect(researchPreset(f.deps, f.campaign(), 'writing')).rejects.toThrow('结果尚未独立复核')
})

test('detached experiment imports require matching launch and terminal receipts in the conversation tree', async () => {
  const f = await setup()
  const child = createConversation(f.store, {
    workspaceId: f.workspace.id,
    parentConversationId: f.parent.id,
    source: 'workflow',
    sourceRef: 'experiment-engineer',
    provider: 'test',
    model: 'test',
  })
  const run = createRun(f.store, {
    conversationId: child.id,
    workspaceId: f.workspace.id,
    model: 'test',
    clientRequestId: 'detach',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const launch = appendStep(f.store, {
    runId: run.id,
    seq: 1,
    kind: 'tool_action',
    toolName: 'ssh_run_command',
    status: 'success',
    payload: {
      kind: 'tool_result',
      args: { detach: true },
      outcome: {
        status: 'success',
        executed: true,
        message: 'Launched',
        data: { profile: 'gpu', runDir: '/runs/actual', pid: 42, state: 'running' },
      },
    },
  })
  const status = (state: string, pid = 42, profile = 'gpu') =>
    appendStep(f.store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'ssh_job_status',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { profile, runDir: '/runs/actual' },
        outcome: {
          status: 'success',
          executed: true,
          message: state,
          data: {
            profile,
            runDir: '/runs/actual',
            pid,
            state,
            exitCode: state === 'failed' ? 7 : state === 'completed' ? 0 : null,
            logTail: 'Epoch 1\n{"metrics_summary":{"auroc":"unknown"}}',
          },
        },
      },
    })
  const document = {
    ...f.experiment,
    key: 'detach',
    sourceStepId: launch.id,
    statusStepId: status('unknown').id,
    summary: {
      run_dir: '/runs/actual',
      pid: 42,
      exit_code: 0,
      metrics_summary: { auroc: 'unknown' },
    },
  }
  await expect(f.write('experiment', document)).rejects.toThrow('provenance')
  for (const wrong of [status('completed', 99), status('completed', 42, 'other-profile')])
    await expect(f.write('experiment', { ...document, statusStepId: wrong.id })).rejects.toThrow(
      'provenance',
    )
  const completed = status('completed')
  await expect(
    f.write('experiment', {
      ...document,
      statusStepId: completed.id,
      summary: { ...document.summary, metrics_summary: { auroc: 0.99 } },
    }),
  ).rejects.toThrow('provenance')
  const saved = await f.write('experiment', { ...document, statusStepId: completed.id })
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).find(
      (doc) => doc.contentHash === saved.contentHash,
    )?.verified,
  ).toBe(true)
  await expect(researchPreset(f.deps, f.campaign(), 'writing')).rejects.toThrow('独立复核')
  const failed = status('failed')
  const negative = await f.write('experiment', {
    ...document,
    key: 'failed-run',
    statusStepId: failed.id,
    summary: { ...document.summary, exit_code: 7 },
  })
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).find(
      (doc) => doc.contentHash === negative.contentHash,
    )?.verified,
  ).toBe(true)
  const other = createConversation(f.store, {
    workspaceId: f.workspace.id,
    provider: 'test',
    model: 'test',
  })
  const otherContext = await assistantContext(f.deps, [
    { ...f.campaign(), parentConversationId: other.id },
  ])
  expect(otherContext.campaigns[0]?.experimentSources).toHaveLength(0)
})

test('campaign usage includes nested and archived members, separates currencies and excludes unavailable CLI usage', async () => {
  const { archiveConversation, updateRunUsage } = await import('@oph-autoresearch/store')
  const { campaignUsage } = await import('./campaign-usage.ts')
  const f = await setup()
  const makeChild = (parent: typeof f.parent) =>
    createConversation(f.store, {
      workspaceId: f.workspace.id,
      parentConversationId: parent.id,
      source: 'workflow',
      sourceRef: 'fixture',
      provider: 'test',
      model: 'test',
    })
  const child = makeChild(f.parent),
    nested = makeChild(child),
    cli = makeChild(nested)
  const addUsage = (conversation: typeof child, currency: 'USD' | 'CNY', cost: number | null) => {
    const run = createRun(f.store, {
      conversationId: conversation.id,
      workspaceId: f.workspace.id,
      model: 'test',
      clientRequestId: conversation.id,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    updateRunUsage(f.store, run.id, {
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      cost,
      currency,
      turns: [],
      ...(cost === null ? { reporting: 'unavailable' } : {}),
    })
  }
  addUsage(child, 'USD', 1.2)
  addUsage(nested, 'CNY', 8)
  addUsage(cli, 'USD', null)
  archiveConversation(f.store, child.id)
  const other = createConversation(f.store, {
    workspaceId: f.workspace.id,
    provider: 'test',
    model: 'test',
  })
  addUsage(other, 'USD', 999)
  const usage = campaignUsage(f.store, f.parent.id)
  expect(usage).toMatchObject({
    conversationCount: 4,
    runCount: 4,
    inputTokens: 20,
    outputTokens: 40,
    unavailableRuns: 1,
    costs: [
      { currency: 'CNY', cost: 8 },
      { currency: 'USD', cost: 1.2 },
    ],
  })
})

test('human approval after analysis also covers its upstream independent review', async () => {
  const f = await setup()
  const review = await reviewFixture(f, true, true)
  const saved = await f.write('resultsreview', review.document)
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).find(
      (doc) => doc.contentHash === saved.contentHash,
    )?.verified,
  ).toBe(true)
})
