import { afterEach, describe, expect, test } from 'bun:test'
import { createConversation, Store, upsertWorkspace } from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { handleResearchControlApi } from './controller-bridge.ts'
import type { ApiRequestDeps } from './types.ts'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('research control bridge', () => {
  test('uses the campaign ledger while refusing approval and release verbs', async () => {
    const store = new Store({ path: ':memory:' })
    stores.push(store)
    const workspace = upsertWorkspace(store, '/tmp/research-control', 'control')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const deps = {
      store,
      workspaceId: workspace.id,
      workspaceRoot: '/tmp/research-control',
      bus: new EventBus(),
    } as unknown as ApiRequestDeps
    const call = async (body: unknown) => {
      const url = new URL('http://localhost/api/research/control')
      return (await handleResearchControlApi(
        url,
        new Request(url.toString(), { method: 'POST', body: JSON.stringify(body) }),
        deps,
      ))!
    }
    const rejected = await call({ operation: 'approve' })
    expect(rejected.status).toBe(400)
    const created = await call({
      operation: 'prepare',
      body: { parentConversationId: parent.id, goal: 'local synthetic', idempotencyKey: 'create' },
    })
    expect(created.status).toBe(200)
    const result = (await created.json()) as { campaign: { id: string; version: number } }
    const proposed = await call({
      operation: 'propose',
      campaignId: result.campaign.id,
      body: {
        expectedVersion: result.campaign.version,
        idempotencyKey: 'inputs',
        command: { kind: 'setInputs', inputs: { fixture: 'local' } },
      },
    })
    expect(proposed.status).toBe(200)
  })
})
