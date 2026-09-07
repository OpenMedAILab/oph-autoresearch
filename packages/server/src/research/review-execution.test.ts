import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { executeEvidenceReview, quoteEvidenceReview } from './review-execution.ts'
import { syntheticProtocol } from './synthetic-protocol.ts'
import { SYNTHETIC_SKILL_BINDING } from './synthetic-skill.ts'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)
function sse(events: unknown[]) {
  return `${events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n`).join('\n')}\n`
}
function toolTurn() {
  return sse([
    { type: 'response.created', response: { id: 'tool' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'read_skill' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc',
      delta: JSON.stringify({ name: 'oph-generated-evidence-pack' }),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: { id: 'tool', status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } },
    },
  ])
}
function finalTurn(artifactVersionId: string) {
  return sse([
    { type: 'response.created', response: { id: 'final' } },
    {
      type: 'response.output_text.delta',
      delta: JSON.stringify({
        decision: 'supported',
        claims: [
          {
            claim: 'Fixed aggregate evidence is internally consistent.',
            artifactVersionIds: [artifactVersionId],
          },
        ],
        limitations: ['Synthetic phantom evidence only.'],
      }),
    },
    {
      type: 'response.completed',
      response: { id: 'final', status: 'completed', usage: { input_tokens: 20, output_tokens: 5 } },
    },
  ])
}
async function setup(mode: 'final' | 'two' | 'three' = 'final', budgetLimit = 1_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'oph-review-execution-'))
  roots.push(root)
  const calls: string[] = []
  let artifactVersionId = ''
  let turns = 0
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.text()
      calls.push(body)
      turns++
      return new Response(
        mode === 'final'
          ? finalTurn(artifactVersionId)
          : mode === 'two'
            ? turns === 1
              ? toolTurn()
              : finalTurn(artifactVersionId)
            : toolTurn(),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const config: OphConfig = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    mode: 'auto',
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
  }
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, root, 'review-execution')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  })
  const made = createResearchCampaign(store, {
    idempotencyKey: crypto.randomUUID(),
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'fixed only',
    policy: {},
    inputs: {},
    budget: { currency: 'CNY', limit: budgetLimit },
  })
  if (!made.ok) throw new Error(made.message)
  const declared = mutateResearchCampaign(store, made.campaign.id, {
    expectedVersion: made.campaign.version,
    idempotencyKey: 'declare-evidence-task',
    command: {
      kind: 'declareSyntheticTask',
      taskId: 'evidence-task',
      skillBinding: SYNTHETIC_SKILL_BINDING,
      artifactVersionIds: [],
      inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
    },
  })
  if (!declared.ok) throw new Error(declared.message)
  const protocol = syntheticProtocol(store, root, made.campaign.id)
  const submitted = await protocol.submit({
    expectedVersion: declared.campaign.version,
    taskRevisionId: declared.campaign.taskRevisions[0]!.id,
    dispatchKey: 'evidence',
    templateId: 'synthetic-summary-v1',
  })
  if (!submitted.ok) throw new Error(submitted.error)
  artifactVersionId =
    submitted.campaign.attempts.find((attempt) => attempt.id === submitted.attemptId)
      ?.artifactVersionId ?? ''
  return {
    root,
    provider,
    calls,
    config,
    store,
    campaignId: submitted.campaign.id,
    attemptIds: [submitted.attemptId],
  }
}
async function approve(
  input: Awaited<ReturnType<typeof setup>>,
  dispatchKey: string,
  maxCost = 1_000_000,
  cli?: { workerArgv?: readonly string[] },
) {
  const quote = await quoteEvidenceReview({
    ...(cli ? { cli } : {}),
    store: input.store,
    config: input.config,
    workspaceRoot: input.root,
    campaignId: input.campaignId,
    attemptIds: input.attemptIds,
  })
  const campaign = getResearchCampaign(input.store, input.campaignId)!
  const approved = mutateResearchCampaign(input.store, campaign.id, {
    expectedVersion: campaign.version,
    idempotencyKey: crypto.randomUUID(),
    command: {
      kind: 'approve',
      bundleHash: campaign.bundleHash,
      reviewer: {
        reviewerId: 'trusted-reviewer',
        proofId: crypto.randomUUID(),
        verifiedAt: Date.now(),
      },
      scope: {
        kind: 'model_review',
        evidencePackHash: quote.evidencePackHash,
        configHash: quote.configHash,
        maxRequests: 2,
        maxOutputTokens: 1024,
        expiresAt: Date.now() + 60_000,
        currency: quote.currency,
        maxCost,
        dispatchKey,
        artifactVersionIds: quote.artifactVersionIds,
      },
    },
  })
  if (!approved.ok) throw new Error(approved.message)
  return {
    quote,
    approvalId: approved.campaign.approvals.at(-1)!.id,
    version: approved.campaign.version,
  }
}
describe('model evidence review execution', () => {
  test('native CLI uses a fresh process and scrubbed scratch while the parent owns request budget and replay', async () => {
    const input = await setup('two')
    const before = input.store.db.query('SELECT count(*) as n FROM conversations').get()
    const envName = 'OPH_EVIDENCE_PARENT_CANARY'
    const previous = process.env[envName]
    process.env[envName] = 'private-parent-environment'
    const observation = join(input.root, 'worker-observation.json')
    const workerUrl = pathToFileURL(join(import.meta.dir, 'evidence-cli-worker.ts')).href
    const wrapper = `await Bun.write(${JSON.stringify(observation)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),env:process.env})); const {runEvidenceCliWorker}=await import(${JSON.stringify(workerUrl)}); await runEvidenceCliWorker();`
    const cli = { workerArgv: [process.execPath, '--eval', wrapper] }
    try {
      const approval = await approve(input, 'cli-once', 1_000_000, cli)
      const request = {
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: approval.version,
        dispatchKey: 'cli-once',
        approvalId: approval.approvalId,
        signal: new AbortController().signal,
        cli,
      }
      const results = await Promise.all([
        executeEvidenceReview(request),
        executeEvidenceReview(request),
      ])
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      const first = results.find((result) => !result.replayed)!
      const second = results.find((result) => result.replayed)!
      expect(first.review.status).toBe('done')
      expect(first.review.executionBackend).toBe('builtin-cli')
      expect(first.review.requestCount).toBe(2)
      expect(second.replayed).toBe(true)
      expect(input.calls).toHaveLength(2)
      for (const body of input.calls) {
        expect(JSON.parse(body).max_output_tokens).toBe(1024)
        expect(body).not.toContain('private-parent-environment')
      }
      const observed = JSON.parse(await readFile(observation, 'utf8')) as {
        pid: number
        cwd: string
        env: Record<string, string>
      }
      expect(observed.pid).not.toBe(process.pid)
      expect(observed.cwd).not.toBe(input.root)
      expect(observed.env[envName]).toBeUndefined()
      expect(observed.env.OPH_AUTORESEARCH_HOME).toBe(observed.cwd)
      expect(observed.env.USERPROFILE).toBe(observed.cwd)
      expect(input.store.db.query('SELECT count(*) as n FROM conversations').get()).toEqual(before)
      await expect(stat(observed.cwd)).rejects.toThrow()
      expect((await executeEvidenceReview(request)).replayed).toBe(true)
      expect(input.calls).toHaveLength(2)
      const { cli: _cli, ...sessionRequest } = request
      const sessionQuote = await quoteEvidenceReview(sessionRequest)
      expect(sessionQuote.configHash).not.toBe(approval.quote.configHash)
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
      input.provider.stop(true)
      input.store.close()
    }
  })
  test('native CLI cannot send a third provider request after the signed request limit', async () => {
    const input = await setup('three')
    try {
      const cli = {}
      const approval = await approve(input, 'cli-limit', 1_000_000, cli)
      const result = await executeEvidenceReview({
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: approval.version,
        dispatchKey: 'cli-limit',
        approvalId: approval.approvalId,
        signal: new AbortController().signal,
        cli,
      })
      expect(input.calls).toHaveLength(2)
      expect(result.review.requestCount).toBe(2)
      expect(result.review.status).not.toBe('done')
      expect(result.review.reservedCost).toBeGreaterThan(0)
    } finally {
      input.provider.stop(true)
      input.store.close()
    }
  })
  for (const change of ['policy', 'producer-revision'] as const) {
    test(`completed review retains history but becomes stale after ${change}`, async () => {
      const input = await setup()
      try {
        const approval = await approve(input, 'stale-review')
        const result = await executeEvidenceReview({
          store: input.store,
          config: input.config,
          workspaceRoot: input.root,
          campaignId: input.campaignId,
          attemptIds: input.attemptIds,
          expectedVersion: approval.version,
          dispatchKey: 'stale-review',
          approvalId: approval.approvalId,
          signal: new AbortController().signal,
        })
        expect(result.review.sourceValidity).toBe('current')
        const current = getResearchCampaign(input.store, input.campaignId)!
        const task = current.taskRevisions[0]!
        const changed = mutateResearchCampaign(input.store, current.id, {
          expectedVersion: current.version,
          idempotencyKey: 'invalidate-review',
          command:
            change === 'policy'
              ? { kind: 'setPolicy', policy: { revision: 2 } }
              : {
                  kind: 'declareSyntheticTask',
                  taskId: task.taskId!,
                  previousRevisionId: task.id,
                  skillBinding: task.skillBinding,
                  templateId: task.templateId,
                  inputHash: task.inputHash,
                  artifactVersionIds: [],
                },
        })
        if (!changed.ok) throw new Error(changed.message)
        const observed = getResearchCampaign(input.store, input.campaignId)!
        expect(observed.modelReviews?.[0]).toMatchObject({
          id: result.review.id,
          status: 'done',
          sourceValidity: 'stale',
          text: result.review.text,
        })
        expect(getResearchCampaign(input.store, input.campaignId)?.bundleHash).toBe(
          observed.bundleHash,
        )
        expect(input.calls).toHaveLength(1)
      } finally {
        input.provider.stop(true)
        input.store.close()
      }
    })
  }
  test('concurrent identical dispatches share one reservation and one actual model request', async () => {
    const input = await setup()
    try {
      const approval = await approve(input, 'concurrent-review')
      const request = {
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: approval.version,
        dispatchKey: 'concurrent-review',
        approvalId: approval.approvalId,
        signal: new AbortController().signal,
      }
      const results = await Promise.all([
        executeEvidenceReview(request),
        executeEvidenceReview(request),
      ])
      expect(results.filter((result) => result.replayed)).toHaveLength(1)
      expect(new Set(results.map((result) => result.review.id)).size).toBe(1)
      expect(input.calls).toHaveLength(1)
      expect(getResearchCampaign(input.store, input.campaignId)?.modelReviews).toHaveLength(1)
    } finally {
      input.provider.stop(true)
      input.store.close()
    }
  })
  test('quotes exact evidence, executes one model request, and replays without a new provider request', async () => {
    const input = await setup()
    try {
      const approved = await approve(input, 'review-once')
      expect(approved.quote).toMatchObject({
        evidencePackHash: expect.stringMatching(/^sha256:/),
        artifactVersionIds: [expect.any(String)],
        currency: 'CNY',
        maxRequests: 2,
        maxOutputTokens: 1024,
        reservedCost: expect.any(Number),
        configHash: expect.stringMatching(/^sha256:/),
      })
      const first = await executeEvidenceReview({
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: approved.version,
        dispatchKey: 'review-once',
        approvalId: approved.approvalId,
        signal: new AbortController().signal,
      })
      expect(first).toMatchObject({
        replayed: false,
        review: { status: 'done', requestCount: 1, actualCost: expect.any(Number) },
      })
      expect(input.calls).toHaveLength(1)
      const replay = await executeEvidenceReview({
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: 1,
        dispatchKey: 'review-once',
        approvalId: approved.approvalId,
        signal: new AbortController().signal,
      })
      expect(replay).toMatchObject({ replayed: true })
      expect(input.calls).toHaveLength(1)
    } finally {
      input.provider.stop(true)
      input.store.close()
    }
  })
  test('denies an unapproved raw execution before provider dispatch', async () => {
    const input = await setup()
    try {
      await expect(
        executeEvidenceReview({
          store: input.store,
          config: input.config,
          workspaceRoot: input.root,
          campaignId: input.campaignId,
          attemptIds: input.attemptIds,
          expectedVersion: getResearchCampaign(input.store, input.campaignId)!.version,
          dispatchKey: 'no-approval',
          approvalId: 'missing',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/Review requires/)
      expect(input.calls).toHaveLength(0)
    } finally {
      input.provider.stop(true)
      input.store.close()
    }
  })
  test('allows a tool read then final answer within two guarded requests, but refuses a third', async () => {
    const two = await setup('two')
    try {
      const approved = await approve(two, 'two-calls')
      const result = await executeEvidenceReview({
        store: two.store,
        config: two.config,
        workspaceRoot: two.root,
        campaignId: two.campaignId,
        attemptIds: two.attemptIds,
        expectedVersion: approved.version,
        dispatchKey: 'two-calls',
        approvalId: approved.approvalId,
        signal: new AbortController().signal,
      })
      expect(result.review).toMatchObject({ status: 'done', requestCount: 2 })
      expect(two.calls).toHaveLength(2)
    } finally {
      two.provider.stop(true)
      two.store.close()
    }
    const three = await setup('three')
    try {
      const approved = await approve(three, 'three-calls')
      const result = await executeEvidenceReview({
        store: three.store,
        config: three.config,
        workspaceRoot: three.root,
        campaignId: three.campaignId,
        attemptIds: three.attemptIds,
        expectedVersion: approved.version,
        dispatchKey: 'three-calls',
        approvalId: approved.approvalId,
        signal: new AbortController().signal,
      })
      expect(result.review).toMatchObject({ status: 'failed', requestCount: 2 })
      expect(three.calls).toHaveLength(2)
    } finally {
      three.provider.stop(true)
      three.store.close()
    }
  })
})

test('blocks a second approved reservation when aggregate reserved cost exceeds the campaign budget', async () => {
  const input = await setup('final', 10)
  try {
    const first = await approve(input, 'budget-first', 10)
    const second = await approve(input, 'budget-second', 10)
    await executeEvidenceReview({
      store: input.store,
      config: input.config,
      workspaceRoot: input.root,
      campaignId: input.campaignId,
      attemptIds: input.attemptIds,
      expectedVersion: second.version,
      dispatchKey: 'budget-first',
      approvalId: first.approvalId,
      signal: new AbortController().signal,
    })
    const current = getResearchCampaign(input.store, input.campaignId)!
    await expect(
      executeEvidenceReview({
        store: input.store,
        config: input.config,
        workspaceRoot: input.root,
        campaignId: input.campaignId,
        attemptIds: input.attemptIds,
        expectedVersion: current.version,
        dispatchKey: 'budget-second',
        approvalId: second.approvalId,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/available reserved budget/)
    expect(input.calls).toHaveLength(1)
  } finally {
    input.provider.stop(true)
    input.store.close()
  }
})
