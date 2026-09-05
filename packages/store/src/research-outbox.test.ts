import { expect, test } from 'bun:test'
import { Store } from './db.ts'
import { createConversation, upsertWorkspace } from './repos.ts'
import { createResearchCampaign, mutateResearchCampaign } from './research.ts'
import { deliverResearchOutbox } from './research-outbox.ts'

test('outbox publishes committed campaign order and replays an unacknowledged batch', () => {
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, 'D:/synthetic-outbox', 'synthetic')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const created = createResearchCampaign(store, {
      idempotencyKey: 'create',
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'synthetic',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
    })
    if (!created.ok) throw new Error(created.message)
    mutateResearchCampaign(store, created.campaign.id, {
      idempotencyKey: 'inputs',
      expectedVersion: 1,
      command: { kind: 'setInputs', inputs: { fixture: true } },
    })
    const seen: number[] = []
    expect(() =>
      deliverResearchOutbox(store, (event) => {
        seen.push(event.sequence)
        if (event.sequence === 2) throw new Error('transport stopped before ack')
      }),
    ).toThrow('transport stopped')
    expect(seen).toEqual([1, 2])
    expect(deliverResearchOutbox(store, (event) => seen.push(event.sequence))).toBe(2)
    expect(seen).toEqual([1, 2, 1, 2])
    expect(
      deliverResearchOutbox(store, () => {
        throw new Error('duplicate delivery')
      }),
    ).toBe(0)
  } finally {
    store.close()
  }
})
