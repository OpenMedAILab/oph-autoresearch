import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { handleResearchDocumentsApi } from './research-documents.ts'
import type { ApiRequestDeps } from './types.ts'

const roots: string[] = []
const stores: Store[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('research documents API enforces exact bodies and workspace isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-documents-api-'))
  roots.push(root)
  const store = new Store({ path: ':memory:' })
  stores.push(store)
  const workspace = upsertWorkspace(store, root, 'documents-api')
  const other = upsertWorkspace(store, `${root}-other`, 'other')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const made = createResearchCampaign(store, {
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: 'fixed only',
    idempotencyKey: 'create',
    policy: {},
    inputs: {},
    budget: { currency: 'USD', limit: 0 },
  })
  if (!made.ok) throw new Error(made.message)
  const url = new URL(`http://localhost/api/research/campaigns/${made.campaign.id}/documents`)
  const deps = {
    store,
    workspaceId: workspace.id,
    workspaceRoot: root,
    bus: new EventBus(),
  } as unknown as ApiRequestDeps
  const wrongWorkspace = await handleResearchDocumentsApi(url, new Request(url.toString()), {
    ...deps,
    workspaceId: other.id,
  })
  expect(wrongWorkspace?.status).toBe(404)
  const malformed = await handleResearchDocumentsApi(
    url,
    new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        idempotencyKey: 'body',
        kind: 'study',
        document: {},
        extra: true,
      }),
    }),
    deps,
  )
  expect(malformed?.status).toBe(400)
})
