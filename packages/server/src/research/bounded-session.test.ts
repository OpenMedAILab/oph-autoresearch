import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchCommand } from '@oph-autoresearch/core'
import { type OphConfig, Session } from '@oph-autoresearch/runtime'
import {
  appendMessage,
  controllerApprovalScope,
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { createBoundedController, quoteBoundedController } from './bounded-controller.ts'
import { boundedControllerDecision } from './bounded-scheduler.ts'

test('real Session sends only scoped control tools through the durable guard and stops oversized saved history locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oph-bounded-session-'))
  const store = new Store({ path: ':memory:' })
  const bodies: Record<string, unknown>[] = []
  let beforeTransport: () => void = () => {}
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>)
      beforeTransport()
      const frames = [
        {
          id: 'fixture',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '等待独立审批。' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'fixture',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 },
        },
      ]
      return new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const config: OphConfig = {
    active: { provider: 'fixture', model: 'deepseek-v4-flash' },
    providers: {
      fixture: {
        kind: 'openai_chat_completions',
        apiKey: 'not-a-real-key',
        baseUrl: `${provider.url.origin}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
  }
  const workspace = upsertWorkspace(store, root, 'bounded session test')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fixture',
    model: 'deepseek-v4-flash',
  })
  const made = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'local transport fixture',
    policy: {},
    inputs: { synthetic: true },
    budget: { currency: 'CNY', limit: 100 },
    idempotencyKey: 'create',
  })
  if (!made.ok) throw new Error(made.message)
  const get = () => getResearchCampaign(store, made.campaign.id)!
  let sequence = 0
  const mutate = (command: ResearchCommand) => {
    const result = mutateResearchCampaign(store, get().id, {
      expectedVersion: get().version,
      idempotencyKey: `session:${sequence++}`,
      command,
    })
    if (!result.ok) throw new Error(result.message)
  }
  const limits = {
    maxAdvances: 5,
    maxModelRequests: 5,
    maxOutputTokens: 1024,
    maxInputCharacters: 12000,
    deadlineAt: Date.now() + 60000,
    stopAfter: 'candidate' as const,
  }
  const quote = quoteBoundedController(config, get(), limits)
  mutate({
    kind: 'approve',
    approvalId: 'approval',
    bundleHash: get().bundleHash,
    scope: controllerApprovalScope(get(), { ...quote, expiresAt: limits.deadlineAt }),
    reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
  })
  mutate({
    kind: 'activateBoundedResearch',
    reservationId: 'reservation',
    approvalId: 'approval',
    limits,
    configHash: quote.configHash,
    currency: quote.currency,
    reservedCost: quote.reservedCost,
    expectedGeneration: 0,
  })
  const port = { execute: async () => ({ ok: true, status: 200, data: {} }) }
  const rounds: ReturnType<typeof createBoundedController>[] = []
  const sessions: Session[] = []
  const run = async () => {
    const round = createBoundedController({
      store,
      config,
      campaignId: get().id,
      port,
      changed: () => {},
    })
    rounds.push(round)
    const session = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: AbortSignal.timeout(10000),
      researchControllerOnly: true,
      researchControl: round.port,
      researchRequestGuard: round.guard,
      extraSystem: '仅沿当前研究的受控工具推进，等待人类批准时结束本轮。',
      maxSteps: 5,
    })
    sessions.push(session)
    try {
      return await Array.fromAsync(session.ask('读取研究状态并等待下一步。', conversation.id))
    } finally {
      round.finish()
      session.dispose()
    }
  }
  try {
    beforeTransport = () =>
      expect(get().controllerReservations![0]!.requests.at(-1)!.status).toBe('sending')
    const first = await run()
    expect(first.some((event) => event.type === 'run.error')).toBe(false)
    expect(bodies).toHaveLength(1)
    const tools = bodies[0]!.tools as Array<{ function: { name: string } }>
    expect(tools.map((tool) => tool.function.name)).toEqual(['research_control'])
    expect(bodies[0]!.max_tokens).toBe(1024)
    expect(get().controllerReservations![0]!.requests[0]!.status).toBe('done')
    expect(get().controllerReservations![0]!.actualCost).not.toBeNull()
    expect(boundedControllerDecision(get())).toBe('change')
    mutate({
      kind: 'declareSyntheticTask',
      taskId: 'new-task',
      inputHash: `sha256:${'a'.repeat(64)}`,
      artifactVersionIds: [],
    })
    appendMessage(store, {
      conversationId: conversation.id,
      role: 'user',
      content: 'x'.repeat(25000),
    })
    const oversized = await run()
    expect(oversized.some((event) => event.type === 'run.error')).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(get().controllerReservations![0]!.requests).toHaveLength(1)
    expect(boundedControllerDecision(get())).not.toBe('start')
  } finally {
    for (const session of sessions) session.dispose()
    for (const round of rounds) round.finish()
    provider.stop(true)
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
