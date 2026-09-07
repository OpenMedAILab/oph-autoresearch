import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunId } from '@oph-autoresearch/core'
import {
  createConversation,
  createGoal,
  createResearchCampaign,
  currentGoal,
  getResearchCampaign,
  listResearchEvents,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import type { CommandDeps } from '../deps.ts'
import { pauseGoal, startRun } from '../run-control.ts'
import { RunManager } from '../runs.ts'
import { handleResearchApi } from './research.ts'
import type { ApiRequestDeps } from './types.ts'

test('flow GET is read-only; durable hold precedes interrupt and old hold replay cannot stop resumed controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-progress-'))
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, root, 'progress fixture')
    const conversation = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'fixture',
      model: 'fixture',
    })
    const created = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: conversation.id,
      goal: 'fixture flow',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'fixture',
    })
    if (!created.ok) throw new Error(created.message)
    const bus = new EventBus()
    const runs = new RunManager(store, bus)
    let calls = 0
    const deps = {
      store,
      bus,
      runs,
      workspaceId: workspace.id,
      workspaceRoot: root,
      get researchCliPreparation() {
        calls++
        throw new Error('GET must not touch execution')
      },
    } as unknown as ApiRequestDeps
    const path = `http://localhost/api/research/campaigns/${created.campaign.id}`
    const call = (action: string, body?: unknown) =>
      handleResearchApi(
        new URL(`${path}/${action}`),
        new Request(
          `${path}/${action}`,
          body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
        ),
        deps,
      )
    const before = listResearchEvents(store, created.campaign.id)
    expect((await call('next_actions'))?.status).toBe(200)
    expect((await call('next_actions'))?.status).toBe(200)
    expect(listResearchEvents(store, created.campaign.id)).toEqual(before)
    expect(calls).toBe(0)
    const goal = createGoal(store, { conversationId: conversation.id, objective: 'fixture goal' })
    if (!goal.ok) throw new Error(goal.message)
    runs.arm(conversation.id, { goalId: goal.goal.id, revision: goal.goal.revision })
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => {
      expect(getResearchCampaign(store, created.campaign.id)?.progressControl?.state).toBe('held')
      expect(currentGoal(store, conversation.id)?.status).toBe('paused')
    })
    runs.register({
      conversationId: conversation.id,
      runId: 'fixture-run' as RunId,
      controller,
      startedAt: Date.now(),
    })
    const hold = {
      state: 'held',
      expectedVersion: created.campaign.version,
      expectedGeneration: 0,
      idempotencyKey: 'hold',
    }
    expect((await call('progress', hold))?.status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
    expect(runs.armedOf(conversation.id)).toBeNull()
    runs.unregister('fixture-run' as RunId)
    // Held conversations stop before accessing provider config or producing a model request.
    await startRun(conversation.id, 'must not run', undefined, { store, bus, runs } as Omit<
      CommandDeps,
      'ws'
    >)
    expect(runs.isBusy(conversation.id)).toBe(false)
    const held = getResearchCampaign(store, created.campaign.id)!
    expect(
      (
        await call('progress', {
          state: 'active',
          expectedVersion: held.version,
          expectedGeneration: 1,
          idempotencyKey: 'resume',
        })
      )?.status,
    ).toBe(200)
    const resumed = new AbortController()
    runs.register({
      conversationId: conversation.id,
      runId: 'resumed-run' as RunId,
      controller: resumed,
      startedAt: Date.now(),
    })
    expect((await call('progress', hold))?.status).toBe(200)
    expect(resumed.signal.aborted).toBe(false)
    expect(getResearchCampaign(store, created.campaign.id)?.progressControl).toEqual({
      mode: 'manual',
      state: 'active',
      generation: 2,
    })
    runs.unregister('resumed-run' as RunId)
    // Pause without any active Run still disarms the gap between two rounds.
    runs.arm(conversation.id, { goalId: goal.goal.id, revision: goal.goal.revision })
    expect(pauseGoal(conversation.id, { store, bus, runs })).toEqual({ ok: true })
    expect(runs.armedOf(conversation.id)).toBeNull()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
