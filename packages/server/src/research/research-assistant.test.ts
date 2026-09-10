/** Covers chat tool scope, versioned knowledge, confirmation, scheduler recovery and real preparation delegation with a scripted model. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '@oph-autoresearch/agent'
import type { ResearchCampaign, RunId, StepId } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  appendMessage,
  ContentStore,
  contentPathFor,
  createConversation,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { researchControlTool } from '../../../tools/src/research-control.ts'
import { workflowTool } from '../../../tools/src/workflow.ts'
import { handleResearchAssistantApi } from '../api/research-assistant.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { EventBus } from '../bus.ts'
import { makeDelegate } from '../delegate.ts'
import { ensureResearchWorkspace } from '../research-template.ts'
import { RunManager } from '../runs.ts'
import { createBoundedScheduler } from './bounded-scheduler.ts'
import { createResearchControlPort } from './native-research-control.ts'
import { pendingStudyHandoff, researchPreset } from './research-assistant.ts'
import { readResearchDocuments, writeResearchDocument } from './research-documents.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const work of cleanup.splice(0)) await work()
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oph-chat-research-'))
  const store = new Store({ path: join(root, 'study.sqlite') })
  cleanup.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  ensureResearchWorkspace(root)
  const workspace = upsertWorkspace(store, root, 'research')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  })
  const bus = new EventBus(),
    runs = new RunManager(store, bus)
  const started: string[] = []
  const deps = {
    store,
    config: {
      active: { provider: 'fake', model: 'deepseek-v4-flash' },
      providers: {
        fake: { kind: 'openai_responses', apiKey: 'test', models: { 'deepseek-v4-flash': {} } },
      },
    } as unknown as OphConfig,
    workspaceId: workspace.id,
    workspaceRoot: root,
    bus,
    runs,
    startRun: (_id: string, prompt: string) => {
      started.push(prompt)
    },
  } as unknown as ApiRequestDeps
  const port = createResearchControlPort(deps, [], parent.id)
  const prepared = await researchControlTool.fn(
    { operation: 'prepare', body: { goal: 'Retinal research topic', idempotencyKey: 'topic' } },
    { researchControl: port } as ToolContext,
  )
  expect(prepared.status).toBe('success')
  const created = (prepared.data as { response: { campaign: ResearchCampaign } }).response.campaign
  const campaign = () => getResearchCampaign(store, created.id)!
  const write = async (
    kind: Parameters<typeof writeResearchDocument>[0]['kind'],
    document: Record<string, unknown>,
  ) =>
    writeResearchDocument({
      store,
      workspaceRoot: root,
      campaignId: created.id,
      expectedVersion: campaign().version,
      idempotencyKey: crypto.randomUUID(),
      kind,
      document,
    })
  const source = await write('evidence', {
    key: 'paper',
    title: 'Located fixture paper',
    url: 'https://example.org/paper',
    retrievedAt: '2026-09-06',
    readingDepth: 'partial-full-text',
    license: 'fixture',
    segments: [{ locator: 'Methods paragraph 2', text: 'Split at patient level.' }],
    previousVersion: null,
  })
  const study = {
    question: 'Does the prespecified baseline generalize?',
    PICO: { population: 'prepared data' },
    evidenceCitations: [source.contentHash],
    counterEvidence: ['External validation remains unknown'],
    protocol: {
      experiments: ['baseline'],
      budget: 'One preparation task',
      stopRules: ['No remote execution'],
    },
    endpoints: ['AUROC'],
    splitPlan: { unit: 'patient' },
    codeVersion: 'not prepared',
    previousVersion: null as string | null,
  }
  const plan = await write('study', study)
  const doc = () =>
    campaign()
      .artifactVersions.filter((a) => a.artifactId === 'document-study')
      .at(-1)!
  const confirm = async (documentId = doc().id, contentHash = doc().contentHash) =>
    handleResearchAssistantApi(
      new URL(`http://localhost/api/research/campaigns/${created.id}/assistant/confirm`),
      new Request('http://localhost/', {
        method: 'POST',
        body: JSON.stringify({
          documentId,
          contentHash,
          expectedVersion: campaign().version,
          requestId: crypto.randomUUID(),
        }),
      }),
      deps,
    )
  return {
    root,
    store,
    workspace,
    parent,
    port,
    campaign,
    write,
    source,
    study,
    plan,
    doc,
    confirm,
    deps,
    started,
  }
}
test('chat creates scoped research without execution configuration, stores knowledge and prevents abstract-only writing inference', async () => {
  const f = await setup()
  expect(
    (
      await f.port.execute({
        operation: 'workflow/preset',
        campaignId: '',
        body: { phase: 'discovery' },
      })
    ).ok,
  ).toBe(true)
  expect(
    (
      await f.port.execute({
        operation: 'workflow/preset',
        campaignId: '',
        body: { phase: 'preparation' },
      })
    ).ok,
  ).toBe(false)
  const other = createConversation(f.store, {
    workspaceId: f.workspace.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  })
  expect(
    (
      await createResearchControlPort(f.deps, [], other.id).execute({
        operation: 'status',
        campaignId: f.campaign().id,
      })
    ).status,
  ).toBe(403)
  const venue = {
    key: 'venue',
    name: 'Fixture journal',
    venueType: 'journal',
    year: null,
    track: null,
    officialUrl: 'https://example.org',
    fit: 'Topic fit, unverified publication outlook',
    rules: [
      {
        text: 'Structured abstract',
        url: 'https://example.org/authors',
        retrievedAt: '2026-09-06',
        publishedAt: null,
      },
    ],
    exemplars: [
      {
        evidenceKey: 'paper',
        reason: 'Related methods',
        citationCount: null,
        citationSource: null,
        citationCheckedAt: null,
      },
    ],
    writingInferences: [{ text: 'Methods explain patient split', evidenceKeys: ['paper'] }],
    unknowns: ['Fees not checked'],
    previousVersion: null,
  }
  await f.write('venue', venue)
  const found = await f.port.execute({
    operation: 'knowledge/search',
    campaignId: '',
    body: { query: 'Fixture journal' },
  })
  expect(found.ok).toBe(true)
  expect(JSON.stringify(found.data)).toContain('writingInferences')
  await f.write('evidence', {
    key: 'abstract',
    title: 'Abstract only',
    url: 'https://example.org/abstract',
    retrievedAt: '2026-09-06',
    readingDepth: 'abstract',
    license: 'unknown',
    segments: [{ locator: 'Abstract', text: 'Summary' }],
    previousVersion: null,
  })
  await expect(
    f.write('venue', {
      ...venue,
      key: 'bad',
      exemplars: [],
      writingInferences: [{ text: 'Whole paper structure', evidenceKeys: ['abstract'] }],
    }),
  ).rejects.toThrow('full-text')
  await expect(
    f.write('venue', {
      ...venue,
      key: 'badcount',
      exemplars: [
        {
          evidenceKey: 'paper',
          reason: 'high citation',
          citationCount: 100,
          citationSource: null,
          citationCheckedAt: null,
        },
      ],
    }),
  ).rejects.toThrow('citation provider')
  const denied = await f.port.execute({
    operation: 'propose',
    campaignId: '',
    body: {
      expectedVersion: f.campaign().version,
      idempotencyKey: 'self',
      command: { kind: 'selectStudy', documentId: f.doc().id, contentHash: f.doc().contentHash },
    },
  })
  expect(denied.ok).toBe(false)
})
test('confirmation binds the current version, is idempotent and survives dispatch interruption', async () => {
  const f = await setup(),
    old = f.doc()
  await f.write('study', {
    ...f.study,
    question: 'Revised question',
    previousVersion: f.plan.contentHash,
    revision_note: 'Updated question in response to review',
  })
  expect((await f.confirm(old.id, old.contentHash))?.status).toBe(409)
  expect((await f.confirm())?.status).toBe(200)
  expect((await f.confirm())?.status).toBe(200)
  expect(f.started).toHaveLength(1)
  expect(f.campaign().approvals).toHaveLength(0)
  const request = pendingStudyHandoff(f.store, f.campaign())
  expect(request).toContain('禁止远端写入或训练')
  const restarted = new Store({ path: join(f.root, 'study.sqlite') })
  const resumed: string[] = []
  const scheduler = createBoundedScheduler({
    store: restarted,
    isBusy: () => false,
    startRun: () => {
      throw new Error('not a bounded run')
    },
    startStudyHandoff: (_id, prompt) => resumed.push(prompt),
    changed: () => {},
    intervalMs: 60_000,
  })
  scheduler.tick()
  scheduler.tick()
  scheduler.close()
  expect(resumed).toEqual([request!])
  appendMessage(restarted, { conversationId: f.parent.id, role: 'user', content: request! })
  expect(
    pendingStudyHandoff(restarted, getResearchCampaign(restarted, f.campaign().id)!),
  ).toBeNull()
  restarted.close()
})
test('review cases preserve paper groups and keep restricted, synthetic and held-out cases out of model context', async () => {
  const f = await setup()
  const item = {
    key: 'review',
    paperGroup: 'paper-group',
    manuscriptVersion: 'submitted-v1',
    venue: 'Fixture venue',
    round: 1,
    manuscript: 'Restricted manuscript',
    review: 'Reviewer comments',
    source: 'User provided',
    sourceKind: 'user-declared',
    usage: 'local-only',
    split: 'test',
    deidentified: true,
    license: 'Local storage only',
    previousVersion: null,
  }
  const savedCase = await f.write('reviewcase', item)
  await expect(
    f.write('reviewcase', { ...item, previousVersion: savedCase.contentHash, split: 'train' }),
  ).rejects.toThrow('same split')
  await expect(
    f.write('reviewcase', { ...item, key: 'other-round', round: 2, split: 'train' }),
  ).rejects.toThrow('same split')
  const context = await f.port.execute({ operation: 'context', campaignId: '' })
  expect(JSON.stringify(context.data)).not.toContain('Restricted manuscript')
  const docs = await f.port.execute({ operation: 'documents/read', campaignId: '' })
  expect(JSON.stringify(docs.data)).not.toContain('Reviewer comments')
  expect(
    (await readResearchDocuments(f.store, f.root, f.campaign().id)).some(
      (d) => d.kind === 'reviewcase',
    ),
  ).toBe(true)
})

test('confirmed preparation executes the existing workflow and child model tool, producing a real local artifact', async () => {
  const f = await setup()
  await f.confirm()
  let calls = 0
  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      await req.text()
      calls++
      const item = {
        type: 'function_call',
        id: 'fc_write',
        call_id: 'call_write',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'research/experiment_handoff.md',
          content:
            '# Experiment preparation\nFixture tasks: patient split, baseline, metric report. No remote execution.',
        }),
      }
      return new Response(
        sse(
          calls === 1
            ? [
                { type: 'response.created', response: { id: 'response1' } },
                {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { ...item, arguments: '' },
                },
                {
                  type: 'response.function_call_arguments.delta',
                  item_id: item.id,
                  output_index: 0,
                  delta: item.arguments,
                },
                { type: 'response.output_item.done', output_index: 0, item },
                {
                  type: 'response.completed',
                  response: {
                    id: 'response1',
                    status: 'completed',
                    output: [item],
                    usage: { input_tokens: 20, output_tokens: 20 },
                  },
                },
              ]
            : [
                { type: 'response.created', response: { id: 'response2' } },
                {
                  type: 'response.output_text.delta',
                  delta: JSON.stringify({
                    key: 'experiment-preparation',
                    studyHash: f.campaign().studySelection!.contentHash,
                    summary: 'Local file prepared by workflow child',
                    tasks: ['baseline'],
                    expectedOutputs: ['metrics'],
                    blockers: ['Executor not configured'],
                    previousVersion: null,
                  }),
                },
                {
                  type: 'response.completed',
                  response: {
                    id: 'response2',
                    status: 'completed',
                    usage: { input_tokens: 20, output_tokens: 20 },
                  },
                },
              ],
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  try {
    const config = {
      active: { provider: 'fake', model: 'deepseek-v4-flash' },
      providers: {
        fake: {
          kind: 'openai_responses',
          apiKey: 'test',
          baseUrl: `${provider.url}v1`,
          models: { 'deepseek-v4-flash': {} },
        },
      },
      mode: 'auto',
    } as unknown as OphConfig
    const delegated = makeDelegate({
      workspaceRoot: f.root,
      conversationId: f.parent.id,
      deps: {
        store: f.store,
        bus: f.deps.bus,
        runs: f.deps.runs,
        content: new ContentStore(contentPathFor(join(f.root, 'study.sqlite'))),
        config,
      },
    })
    const preset = await f.port.execute({
      operation: 'workflow/preset',
      campaignId: '',
      body: { phase: 'preparation' },
    })
    expect(preset.ok).toBe(true)
    const result = await workflowTool.fn(
      (preset.data as { workflow: Record<string, unknown> }).workflow,
      {
        delegate: delegated,
        runId: 'run_fixture' as RunId,
        stepId: 'step_fixture' as StepId,
        signal: new AbortController().signal,
      } as unknown as ToolContext,
    )
    expect(result.status).toBe('success')
    expect(result.message).toContain('核验清单')
    expect(await readFile(join(f.root, 'research/experiment_handoff.md'), 'utf8')).toContain(
      'Fixture tasks',
    )
    expect(calls).toBe(2)
    await f.write('handoff', {
      key: 'experiment-preparation',
      studyHash: f.campaign().studySelection!.contentHash,
      summary: 'Local file prepared by workflow child',
      tasks: ['baseline'],
      expectedOutputs: ['metrics'],
      blockers: ['Executor not configured'],
      previousVersion: null,
    })
    expect(
      (await readResearchDocuments(f.store, f.root, f.campaign().id)).some(
        (d) => d.kind === 'handoff' && d.verified && !d.stale,
      ),
    ).toBe(true)
    for (const [phase, checkpoint] of [
      ['experiment', 'go_training'],
      ['results', 'accepted'],
    ]) {
      const preset = await f.port.execute({
        operation: 'workflow/preset',
        campaignId: '',
        body: { phase },
      })
      expect(preset.ok).toBe(true)
      const nodes = (preset.data as { workflow: { nodes: { id: string; reviewer?: string }[] } })
        .workflow.nodes
      expect(nodes.find((node) => node.id === checkpoint)?.reviewer).toBe('human')
      if (phase === 'results') {
        expect(nodes.map((node) => node.id)).toEqual([
          'collect',
          'review',
          'analysis',
          'reproduce',
          'accepted',
        ])
        expect(nodes.find((node) => node.id === 'accepted')).toMatchObject({
          needs: ['analysis', 'reproduce'],
        })
      }
    }
    expect(f.campaign().attempts).toHaveLength(0)
  } finally {
    provider.stop(true)
  }
})

test('missing source content invalidates the plan and prevents preparation after confirmation', async () => {
  const f = await setup()
  expect((await f.confirm())?.status).toBe(200)
  await rm(fileURLToPath(f.source.uri))
  const docs = await readResearchDocuments(f.store, f.root, f.campaign().id)
  expect(docs.find((d) => d.kind === 'study')?.stale).toBe(true)
  expect((await f.confirm())?.status).toBe(409)
  expect(
    (
      await f.port.execute({
        operation: 'workflow/preset',
        campaignId: '',
        body: { phase: 'preparation' },
      })
    ).ok,
  ).toBe(false)
})

test('discovery challenges use a second configured provider and explicit role choices take precedence', async () => {
  const f = await setup()
  f.deps.config.providers.review = {
    ...f.deps.config.providers.fake!,
    models: { 'review-model': {} },
  }
  const result = await researchPreset(f.deps, f.campaign(), 'discovery')
  const challenges = result.workflow.nodes.filter((node) => node.id.startsWith('challenge_'))
  expect(challenges).toHaveLength(2)
  for (const node of challenges) {
    expect(node).toMatchObject({ provider: 'review', model: 'review-model', needs: ['proposal'] })
  }
  expect(result.workflow.nodes.find((node) => node.id === 'synthesis_final')?.needs).toEqual([
    'challenge_clinical',
    'challenge_methods',
  ])
  expect(result.workflow.nodes.find((node) => node.id === 'synthesis')?.needs).toEqual([
    'synthesis_final',
  ])
  const path = join(f.root, '.oph/team.json')
  const team = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(
    team.roles.find((role: { id: string }) => role.id === 'clinical-challenger'),
    { provider: 'fake', model: 'deepseek-v4-flash' },
  )
  await writeFile(path, JSON.stringify(team))
  const pinned = await researchPreset(f.deps, f.campaign(), 'discovery')
  expect(pinned.workflow.nodes.find((node) => node.id === 'challenge_clinical')).toMatchObject({
    provider: 'fake',
    model: 'deepseek-v4-flash',
  })
  expect(pinned.workflow.nodes.at(-1)).toMatchObject({
    label: expect.stringContaining('同模型审查'),
  })
})

test('single-provider review is labelled and experiment/results retain evidence gates', async () => {
  const f = await setup()
  const result = await researchPreset(f.deps, f.campaign(), 'discovery')
  expect(result.workflow.nodes.at(-1)).toMatchObject({
    label: expect.stringContaining('同模型审查'),
  })
  await expect(researchPreset(f.deps, f.campaign(), 'experiment')).rejects.toThrow('交接包')
  await expect(researchPreset(f.deps, f.campaign(), 'results')).rejects.toThrow('交接包')
})

test('review routing skips empty credentials and ranks effective catalog capabilities', async () => {
  const f = await setup()
  f.deps.config.providers.empty = {
    ...f.deps.config.providers.fake!,
    apiKey: '',
    models: { 'gpt-5.4': {} },
  }
  f.deps.config.providers.review = {
    ...f.deps.config.providers.fake!,
    models: { 'unknown-model': {}, 'deepseek-v4-flash': {} },
  }
  const result = await researchPreset(f.deps, f.campaign(), 'discovery')
  expect(result.workflow.nodes.find((node) => node.id === 'challenge_methods')).toMatchObject({
    provider: 'review',
    model: 'deepseek-v4-flash',
  })
  expect(result.workflow.nodes.find((node) => node.id === 'proposal')).toMatchObject({
    outputKind: 'study',
  })
  expect(result.workflow.nodes.at(-1)).toMatchObject({
    checks: expect.arrayContaining(['与冻结方案的冲突已明确列出。']),
  })
})

test('scripted drift outputs cannot register fake citations, frozen-plan changes, abstract writing or exit-zero success', async () => {
  const f = await setup()
  await f.confirm()
  await f.write('evidence', {
    key: 'abstract',
    title: 'Abstract only',
    url: 'https://example.org/abstract',
    retrievedAt: '2026-09-10',
    readingDepth: 'abstract',
    license: 'fixture',
    segments: [{ locator: 'Abstract', text: 'No methods available' }],
    previousVersion: null,
  })
  const cases = [
    {
      kind: 'study' as const,
      document: {
        ...f.study,
        evidenceCitations: ['doi:invented'],
        previousVersion: f.plan.contentHash,
        revision_note: 'Added reference',
      },
      error: 'unknown evidence citation',
    },
    {
      kind: 'handoff' as const,
      document: {
        key: 'changed-plan',
        studyHash: `sha256:${'0'.repeat(64)}`,
        summary: 'Changed endpoint without confirmation',
        tasks: ['train'],
        expectedOutputs: ['metrics'],
        blockers: [],
        previousVersion: null,
      },
      error: 'currently confirmed study',
    },
    {
      kind: 'venue' as const,
      document: {
        key: 'abstract-venue',
        name: 'Fixture',
        venueType: 'journal',
        year: null,
        track: null,
        officialUrl: 'https://example.org',
        fit: 'unknown',
        rules: [],
        exemplars: [
          {
            evidenceKey: 'abstract',
            reason: 'fixture',
            citationCount: null,
            citationSource: null,
            citationCheckedAt: null,
          },
        ],
        writingInferences: [
          { text: 'Full-text methods use this structure', evidenceKeys: ['abstract'] },
        ],
        unknowns: [],
        previousVersion: null,
      },
      error: 'full-text evidence',
    },
    {
      kind: 'resultsreview' as const,
      document: {
        key: 'exit-zero',
        studyHash: f.plan.contentHash,
        experimentIds: ['exit-code-zero'],
        workflowId: 'nonexistent',
        nodeId: 'review',
        review: {
          decision: 'supported',
          claims: [
            { claim: 'Exit 0 proves clinical benefit', artifactVersionIds: ['exit-code-zero'] },
          ],
          limitations: [],
        },
        previousVersion: null,
      },
      error: 'provenance',
    },
  ]
  let reply = ''
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        [
          { type: 'response.created', response: { id: 'drift' } },
          { type: 'response.output_text.delta', delta: reply },
          {
            type: 'response.completed',
            response: {
              id: 'drift',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 10 },
            },
          },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  try {
    const config = {
      ...f.deps.config,
      mode: 'auto',
      providers: { fake: { ...f.deps.config.providers.fake!, baseUrl: `${provider.url}v1` } },
    } as OphConfig
    const delegate = makeDelegate({
      workspaceRoot: f.root,
      conversationId: f.parent.id,
      deps: {
        store: f.store,
        bus: f.deps.bus,
        runs: f.deps.runs,
        content: new ContentStore(contentPathFor(join(f.root, 'study.sqlite'))),
        config,
      },
    })
    for (const item of cases) {
      reply = JSON.stringify(item.document)
      const result = await delegate.runGraph!({
        call: {
          kind: 'start',
          goal: 'Drift regression',
          maxConcurrent: 1,
          nodes: [
            {
              id: 'producer',
              agent: 'ad-hoc',
              task: 'Return the requested document',
              outputKind: item.kind,
            },
          ],
        },
        runId: 'run_drift',
        stepId: 'step_drift',
        signal: new AbortController().signal,
      })
      expect(result.transition?.phase).toBe('completed') // Structural validity cannot establish scientific truth.
      await expect(
        f.write(item.kind, result.transition!.receipts[0]!.structuredOutput!),
      ).rejects.toThrow(item.error)
    }
    expect(f.campaign().studySelection?.contentHash).toBe(f.plan.contentHash)
    expect(
      (await readResearchDocuments(f.store, f.root, f.campaign().id)).some(
        (doc) => doc.kind === 'resultsreview',
      ),
    ).toBe(false)
  } finally {
    provider.stop(true)
  }
})
