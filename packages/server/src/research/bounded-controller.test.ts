import { expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter } from '@oph-autoresearch/ai'
import type { ResearchCommand } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  controllerApprovalScope,
  createConversation,
  createResearchCampaign,
  getResearchCampaign,
  mutateResearchCampaign,
  researchCostSummary,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { createBoundedController, quoteBoundedController } from './bounded-controller.ts'

const config: OphConfig = {
  active: { provider: 'fixture', model: 'deepseek-v4-flash' },
  providers: {
    fixture: {
      kind: 'openai_chat_completions',
      apiKey: 'never-sent',
      models: { 'deepseek-v4-flash': {} },
    },
  },
}
const request: ChatRequest = {
  model: 'deepseek-v4-flash',
  system: [],
  messages: [{ role: 'user', content: 'fixture' }],
  tools: [],
  maxOutputTokens: null,
}
function setup(maxRequests = 2) {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/oph-bounded-fixture', 'fixture')
  const conversation = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fixture',
    model: 'deepseek-v4-flash',
  })
  const made = createResearchCampaign(store, {
    workspaceId: ws.id,
    parentConversationId: conversation.id,
    goal: 'fixture progression',
    policy: {},
    inputs: { synthetic: true },
    budget: { currency: 'CNY', limit: 100 },
    idempotencyKey: 'create',
  })
  if (!made.ok) throw new Error(made.message)
  const id = made.campaign.id
  const get = () => getResearchCampaign(store, id)!
  let sequence = 0
  const mutate = (command: ResearchCommand) => {
    const result = mutateResearchCampaign(store, id, {
      expectedVersion: get().version,
      idempotencyKey: `test:${sequence++}`,
      command,
    })
    if (!result.ok) throw new Error(result.message)
    return result.campaign
  }
  const limits = {
    maxAdvances: 2,
    maxModelRequests: maxRequests,
    maxOutputTokens: 64,
    maxInputCharacters: 1000,
    deadlineAt: Date.now() + 60000,
    stopAfter: 'candidate' as const,
  }
  const quote = quoteBoundedController(config, get(), limits)
  mutate({
    kind: 'approve',
    approvalId: 'approval-fixture',
    bundleHash: get().bundleHash,
    scope: controllerApprovalScope(get(), { ...quote, expiresAt: Date.now() + 60000 }),
    reviewer: { reviewerId: 'fixture-human', proofId: 'fixture-proof', verifiedAt: Date.now() },
  })
  mutate({
    kind: 'activateBoundedResearch',
    reservationId: 'reservation-fixture',
    approvalId: 'approval-fixture',
    limits,
    configHash: quote.configHash,
    currency: quote.currency,
    reservedCost: quote.reservedCost,
    expectedGeneration: 0,
  })
  const create = () =>
    createBoundedController({
      store,
      config,
      campaignId: id,
      port: { execute: async () => ({ ok: true, status: 200, data: {} }) },
      changed: () => {},
    })
  return { store, get, mutate, quote, create }
}
function adapter(spec: LlmAdapter['spec'], sent: () => void, known = true): LlmAdapter {
  return {
    kind: spec.provider,
    spec,
    transmits: { effort: false },
    stream() {
      sent()
      return (async function* () {
        if (known)
          yield {
            type: 'usage',
            usage: {
              inputTokens: 4,
              outputTokens: 2,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              source: 'provider',
            },
          } as const
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'stop' } as const
      })()
    },
  }
}

test('durable controller budget covers main and implicit adapters before transport and survives new guard instances', async () => {
  const f = setup()
  let sent = 0
  try {
    const first = f.create()
    const raw = adapter(f.quote.spec, () => {
      sent++
      expect(f.get().controllerReservations![0]!.requests.at(-1)!.status).toBe('sending')
    })
    await Array.fromAsync(first.guard.wrap(raw).stream(request))
    first.finish()
    f.mutate({
      kind: 'declareSyntheticTask',
      taskId: 'wake-task',
      inputHash: `sha256:${'a'.repeat(64)}`,
      artifactVersionIds: [],
    })
    const second = f.create()
    await Array.fromAsync(second.guard.wrap(raw).stream(request))
    expect(sent).toBe(2)
    expect(f.get().controllerReservations![0]!.requests).toHaveLength(2)
    expect(f.get().progressControl?.state).toBe('exhausted')
    expect(() => first.guard.wrap(raw).stream(request)).toThrow()
    second.finish()
    expect(f.get().controllerReservations![0]!.status).toBe('exhausted')
    expect(f.get().controllerReservations![0]!.round?.finishedAt).toBeNumber()
  } finally {
    f.store.close()
  }
})

test('unknown usage stays reserved and a held generation cannot restart after resume', async () => {
  const f = setup()
  let sent = 0
  try {
    const first = f.create()
    const raw = adapter(f.quote.spec, () => sent++, false)
    await Array.fromAsync(first.guard.wrap(raw).stream(request))
    expect(f.get().controllerReservations![0]!.actualCost).toBeNull()
    expect(researchCostSummary(f.get()).committedCost).toBe(f.quote.reservedCost)
    f.mutate({ kind: 'setResearchProgress', state: 'held', expectedGeneration: 1 })
    f.mutate({ kind: 'setResearchProgress', state: 'active', expectedGeneration: 2 })
    expect(() => first.guard.wrap(raw).stream(request)).toThrow()
    expect(sent).toBe(1)
    first.finish()
    const resumed = f.create()
    await Array.fromAsync(resumed.guard.wrap(raw).stream(request))
    resumed.finish()
    expect(sent).toBe(2)
  } finally {
    f.store.close()
  }
})

test('controller approval remains scoped to science while evidence changes, but changed input rejects new requests', async () => {
  const f = setup()
  let sent = 0
  try {
    const guard = f.create().guard
    f.mutate({
      kind: 'declareSyntheticTask',
      taskId: 'fixed-task',
      inputHash: `sha256:${'a'.repeat(64)}`,
      artifactVersionIds: [],
    })
    expect(f.get().approvals[0]!.status).toBe('invalidated')
    await Array.fromAsync(guard.wrap(adapter(f.quote.spec, () => sent++)).stream(request))
    f.mutate({ kind: 'setInputs', inputs: { synthetic: 'different' } })
    expect(() => guard.wrap(adapter(f.quote.spec, () => sent++)).stream(request)).toThrow()
    expect(sent).toBe(1)
  } finally {
    f.store.close()
  }
})

test('scheduler waits without spending and wakes the same reservation after remote facts change', async () => {
  const { boundedControllerDecision, createBoundedScheduler } = await import(
    './bounded-scheduler.ts'
  )
  const f = setup(4)
  let starts = 0
  let busy = true
  const scheduler = createBoundedScheduler({
    store: f.store,
    isBusy: () => busy,
    startRun: () => {
      starts++
      busy = true
    },
    changed: () => {},
    intervalMs: 60000,
  })
  try {
    await Bun.sleep(1)
    busy = false
    scheduler.tick()
    expect(starts).toBe(1)
    const round = f.create()
    await Array.fromAsync(round.guard.wrap(adapter(f.quote.spec, () => {})).stream(request))
    round.finish()
    busy = false
    expect(boundedControllerDecision(f.get())).toBe('change')
    scheduler.tick()
    scheduler.tick()
    expect(starts).toBe(1)
    const persist = (state: ReturnType<typeof f.get>) =>
      f.store.db
        .query('UPDATE research_campaigns SET snapshot=? WHERE id=?')
        .run(JSON.stringify(state), state.id)
    const waiting = f.get()
    // Explicit authority-state fixture; no experiment or fabricated result is executed.
    persist({ ...waiting, attempts: [{ id: 'remote-fixture', status: 'running' } as never] })
    scheduler.tick()
    scheduler.tick()
    expect(starts).toBe(1)
    expect(f.get().controllerReservations![0]!.waiting).toBe('remote')
    persist({ ...f.get(), attempts: [{ id: 'remote-fixture', status: 'unknown' } as never] })
    scheduler.tick()
    expect(starts).toBe(1)
    expect(f.get().controllerReservations![0]!.waiting).toBe('unknown')
    persist({ ...f.get(), attempts: [], taskRevisions: [] })
    f.mutate({
      kind: 'declareSyntheticTask',
      taskId: 'new-observed-task',
      inputHash: `sha256:${'b'.repeat(64)}`,
      artifactVersionIds: [],
    })
    scheduler.tick()
    expect(starts).toBe(2)
    expect(f.get().controllerReservations![0]!.requests).toHaveLength(1)
  } finally {
    scheduler.close()
    f.store.close()
  }
})

test('a live round prevents another process starting, while an unstarted expired round can recover', () => {
  const f = setup()
  try {
    const first = f.create()
    expect(() => f.create()).toThrow('尚未结束')
    const campaign = f.get()
    const reservation = campaign.controllerReservations![0]!
    f.store.db.query('UPDATE research_campaigns SET snapshot=? WHERE id=?').run(
      JSON.stringify({
        ...campaign,
        controllerReservations: [
          { ...reservation, round: { ...reservation.round!, expiresAt: Date.now() - 1 } },
        ],
      }),
      campaign.id,
    )
    const recovered = f.create()
    expect(() => first.guard.wrap(adapter(f.quote.spec, () => {})).stream(request)).toThrow(
      '持有权',
    )
    recovered.finish()
  } finally {
    f.store.close()
  }
})
