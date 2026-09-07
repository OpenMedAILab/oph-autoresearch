import { expect, test } from 'bun:test'
import type { ResearchCampaign, ResearchCommand } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
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

function fixture() {
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, '/tmp/oph-scheduler-review', 'scheduler review')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fixture',
    model: 'deepseek-v4-flash',
  })
  const made = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: conversation.id,
    goal: 'scheduler regression',
    policy: {},
    inputs: { synthetic: true },
    budget: { currency: 'CNY', limit: 100 },
    idempotencyKey: 'create',
  })
  if (!made.ok) throw new Error(made.message)
  const get = () => getResearchCampaign(store, made.campaign.id)!
  let sequence = 0
  const mutate = (command: ResearchCommand) => {
    const result = mutateResearchCampaign(store, made.campaign.id, {
      expectedVersion: get().version,
      idempotencyKey: `review:${sequence++}`,
      command,
    })
    if (!result.ok) throw new Error(result.message)
    return result.campaign
  }
  const limits = {
    maxAdvances: 5,
    maxModelRequests: 5,
    maxOutputTokens: 64,
    maxInputCharacters: 1000,
    deadlineAt: Date.now() + 60000,
    stopAfter: 'candidate' as const,
  }
  const quote = quoteBoundedController(config, get(), limits)
  mutate({
    kind: 'approve',
    approvalId: 'controller-approval',
    bundleHash: get().bundleHash,
    scope: controllerApprovalScope(get(), { ...quote, expiresAt: limits.deadlineAt }),
    reviewer: { reviewerId: 'human', proofId: 'proof', verifiedAt: Date.now() },
  })
  mutate({
    kind: 'activateBoundedResearch',
    reservationId: 'controller-reservation',
    approvalId: 'controller-approval',
    limits,
    configHash: quote.configHash,
    currency: quote.currency,
    reservedCost: quote.reservedCost,
    expectedGeneration: 0,
  })
  // Snapshot fixtures model persisted authority states; no transport is called.
  const persist = (campaign: ResearchCampaign) =>
    store.db
      .query('UPDATE research_campaigns SET snapshot=? WHERE id=?')
      .run(JSON.stringify(campaign), campaign.id)
  const controller = () =>
    createBoundedController({
      store,
      config,
      campaignId: get().id,
      port: { execute: async () => ({ ok: true, status: 200, data: {} }) },
      changed: () => {},
    })
  return { store, get, mutate, persist, controller }
}

test('new exact approval wakes a completed round even though the scientific bundle is unchanged', () => {
  const f = fixture()
  try {
    const before = f.get()
    f.persist({
      ...before,
      cliPreparations: [{ id: 'prep', status: 'proposed', dispatchKey: 'dispatch' } as never],
    })
    const round = f.controller()
    f.mutate({
      kind: 'startControllerRequest',
      reservationId: 'controller-reservation',
      requestId: 'request',
      generation: 1,
    })
    f.mutate({
      kind: 'finishControllerRequest',
      reservationId: 'controller-reservation',
      requestId: 'request',
      actualCost: 0,
      completed: true,
    })
    round.finish()
    expect(boundedControllerDecision(f.get())).toBe('human')
    const waiting = f.get()
    const bundleHash = waiting.bundleHash
    f.persist({
      ...waiting,
      approvals: [
        ...waiting.approvals,
        {
          id: 'new-independent-approval',
          status: 'active',
          bundleHash,
          scope: {
            kind: 'cli_preparation',
            dispatchKey: 'dispatch',
            expiresAt: Date.now() + 30000,
          },
        } as never,
      ],
    })
    expect(f.get().bundleHash).toBe(bundleHash)
    expect(boundedControllerDecision(f.get())).toBe('start')
    const resumed = f.controller()
    resumed.finish()
    expect(f.get().controllerReservations).toHaveLength(1)
    expect(f.get().controllerReservations![0]!.requests).toHaveLength(1)
  } finally {
    f.store.close()
  }
})

test('expired round leases never replay a sending or unknown provider request after restart', () => {
  const f = fixture()
  try {
    const round = f.controller()
    f.mutate({
      kind: 'startControllerRequest',
      reservationId: 'controller-reservation',
      requestId: 'interrupted',
      generation: 1,
    })
    round.finish()
    for (const status of ['sending', 'unknown'] as const) {
      const campaign = f.get()
      const reservation = campaign.controllerReservations![0]!
      f.persist({
        ...campaign,
        controllerReservations: [
          {
            ...reservation,
            round: { ...reservation.round!, expiresAt: Date.now() - 1 },
            requests: reservation.requests.map((request) => ({ ...request, status })),
          },
        ],
      })
      expect(boundedControllerDecision(f.get())).toBe('unknown')
      expect(() => f.controller()).toThrow()
      expect(f.get().controllerReservations![0]!.requests).toHaveLength(1)
    }
  } finally {
    f.store.close()
  }
})

test('held progress never restarts because an old remote receipt changed the campaign', () => {
  const f = fixture()
  try {
    f.mutate({ kind: 'setResearchProgress', state: 'held', expectedGeneration: 1 })
    f.mutate({
      kind: 'declareSyntheticTask',
      taskId: 'late-observation',
      inputHash: `sha256:${'a'.repeat(64)}`,
      artifactVersionIds: [],
    })
    expect(boundedControllerDecision(f.get())).toBe('idle')
    expect(() => f.controller()).toThrow()
    expect(f.get().controllerReservations![0]!.requests).toHaveLength(0)
  } finally {
    f.store.close()
  }
})

test('a completed round with no transport does not hot-loop on the same preflight failure', () => {
  const f = fixture()
  try {
    const round = f.controller()
    // Models can reject locally (for example an oversized saved conversation)
    // before beforeSend records a request. Repeating this appends endless runs.
    round.finish()
    expect(f.get().controllerReservations![0]!.requests).toHaveLength(0)
    expect(boundedControllerDecision(f.get())).not.toBe('start')
    expect(() => f.controller()).toThrow()
  } finally {
    f.store.close()
  }
})
