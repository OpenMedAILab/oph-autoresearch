import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { canonicalJson, sha256 } from '../research/skill-lock.ts'
import { handleResearchControlApi } from './controller-bridge.ts'
import type { ApiRequestDeps } from './types.ts'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('research control bridge', () => {
  test('exposes document reads and writes without adding an approval or release operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oph-control-documents-'))
    const store = new Store({ path: ':memory:' })
    stores.push(store)
    try {
      const workspace = upsertWorkspace(store, root, 'control documents')
      const parent = createConversation(store, {
        workspaceId: workspace.id,
        provider: 'test',
        model: 'test',
      })
      const campaign = createResearchCampaign(store, {
        workspaceId: workspace.id,
        parentConversationId: parent.id,
        goal: 'fixed only',
        policy: {},
        inputs: {},
        budget: { currency: 'USD', limit: 0 },
        idempotencyKey: 'control-documents-campaign',
      })
      if (!campaign.ok) throw new Error(campaign.message)
      const source = {
        id: 'citation-control',
        url: 'https://example.test/citation-control',
        title: 'Public metadata',
        publishedAt: null,
        sourceKind: 'public-metadata' as const,
        retrievedAt: 1,
        contentHash: sha256('citation'),
        locator: {
          schema: 'crossref-work-v1' as const,
          pointer: 'citation-control',
          endpoint: 'https://example.test',
        },
      }
      const cited = mutateResearchCampaign(store, campaign.campaign.id, {
        expectedVersion: campaign.campaign.version,
        idempotencyKey: 'citation-control',
        command: {
          kind: 'recordLiteratureCitation',
          citation: {
            ...source,
            projectionHash: sha256(canonicalJson(source)),
            verification: 'retrieved-public-metadata',
            fullText: false,
          },
        },
      })
      if (!cited.ok) throw new Error(cited.message)
      const deps = {
        store,
        workspaceId: workspace.id,
        workspaceRoot: root,
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
      const write = await call({
        operation: 'record_document/write',
        campaignId: campaign.campaign.id,
        body: {
          expectedVersion: cited.campaign.version,
          idempotencyKey: 'control-document-write',
          kind: 'study',
          document: {
            question: 'Does the synthetic endpoint remain stable?',
            PICO: { population: 'synthetic', intervention: 'fixed' },
            evidenceCitations: ['citation-control'],
            counterEvidence: ['Synthetic evidence has no clinical utility claim.'],
            protocol: { version: 1 },
            endpoints: ['aggregate endpoint'],
            splitPlan: { unit: 'patient' },
            codeVersion: 'test',
            previousVersion: null,
          },
        },
      })
      expect(write.status).toBe(201)
      const read = await call({ operation: 'documents/read', campaignId: campaign.campaign.id })
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({ documents: [{ kind: 'study', verified: true }] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
