import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  getConversation,
  getResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { Pairing } from '../pairing.ts'
import { RunManager } from '../runs.ts'
import { handleConversationsApi } from './conversations.ts'
import type { ApiRequestDeps } from './types.ts'

test('deleting an idle parent protects busy descendants and retains independent research after idle cascade', async () => {
  const store = new Store({ path: ':memory:' })
  const root = mkdtempSync(join(tmpdir(), 'oph-delete-tree-'))
  const workspace = upsertWorkspace(store, root, 'test')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'fake',
  })
  const child = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'fake',
    parentConversationId: parent.id,
  })
  const grandchild = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'fake',
    parentConversationId: child.id,
  })
  const research = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: child.id,
    goal: 'retained evidence',
    idempotencyKey: 'create',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  expect(research.ok).toBe(true)
  if (!research.ok) throw new Error(research.message)
  const bus = new EventBus()
  const runs = new RunManager(store, bus)
  const deps: ApiRequestDeps = {
    store,
    bus,
    runs,
    workspaceId: workspace.id,
    workspaceRoot: root,
    config: { active: { provider: 'fake', model: 'fake' }, providers: {} },
    pairing: new Pairing({ deviceName: 'test' }),
    token: 'test',
    port: 0,
    enableLan: () => ({ port: 0 }),
    disableLan() {},
    lanEnabled: () => false,
    lanPort: () => 0,
    startRun() {},
    watchGit() {},
  }
  const url = new URL(`http://localhost/api/conversations/${parent.id}`)
  try {
    for (const active of [child, grandchild]) {
      expect(runs.reserve(active.id)).toBe(true)
      expect(runs.isBusy(parent.id)).toBe(false)
      expect(
        (await handleConversationsApi(url, new Request(url.href, { method: 'DELETE' }), deps))
          ?.status,
      ).toBe(409)
      for (const conversation of [parent, child, grandchild])
        expect(getConversation(store, conversation.id)).not.toBeNull()
      expect(runs.isBusy(active.id)).toBe(true)
      runs.release(active.id)
    }
    expect(
      (await handleConversationsApi(url, new Request(url.href, { method: 'DELETE' }), deps))
        ?.status,
    ).toBe(200)
    for (const conversation of [parent, child, grandchild])
      expect(getConversation(store, conversation.id)).toBeNull()
    expect(getResearchCampaign(store, research.campaign.id)).toEqual(research.campaign)
  } finally {
    store.close()
  }
})
