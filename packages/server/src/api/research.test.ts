import { afterEach, describe, expect, test } from 'bun:test'
import type { ResearchWriteResult } from '@oph-autoresearch/core'
import { createConversation, Store, upsertWorkspace } from '@oph-autoresearch/store'
import { EventBus } from '../bus.ts'
import { handleResearchApi } from './research.ts'
import type { ApiRequestDeps } from './types.ts'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function setup() {
  const store = new Store({ path: ':memory:' })
  stores.push(store)
  const workspace = upsertWorkspace(store, 'D:/synthetic-research', 'synthetic')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'test',
    model: 'test',
  })
  const deps = {
    store,
    workspaceId: workspace.id,
    bus: new EventBus(),
  } as unknown as ApiRequestDeps
  const call = async (path: string, body?: unknown, d = deps) => {
    const url = new URL(`http://localhost/api/research/campaigns${path}`)
    return (await handleResearchApi(
      url,
      new Request(
        url.toString(),
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      ),
      d,
    ))!
  }
  const create = {
    goal: 'Synthetic retina benchmark',
    parentConversationId: parent.id,
    idempotencyKey: 'create-1',
  }
  return { store, parent, deps, call, create }
}

describe('research HTTP boundary', () => {
  test('create and mutation are idempotent; stale versions conflict; events match snapshot', async () => {
    const { call, create } = setup()
    const first = (await (await call('', create)).json()) as ResearchWriteResult
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    const replay = (await (await call('', create)).json()) as ResearchWriteResult
    expect(replay.ok && replay.replayed).toBe(true)
    expect((await call('', { ...create, goal: 'Different' })).status).toBe(409)
    const path = `/${first.campaign.id}`
    const mutation = {
      idempotencyKey: 'input-1',
      expectedVersion: 1,
      command: { kind: 'setInputs', inputs: { dataset: 'synthetic' } },
    }
    expect((await call(`${path}/proposals`, mutation)).status).toBe(200)
    expect(
      (await call(`${path}/proposals`, { ...mutation, idempotencyKey: 'input-2' })).status,
    ).toBe(409)
    const current = (await (await call(path)).json()) as { campaign: { version: number } }
    const events = (await (await call(`${path}/events`)).json()) as { events: unknown[] }
    expect(current.campaign.version).toBe(2)
    expect(events.events).toHaveLength(2)
  })

  test('human actor and bearer do not grant approval or revoke access', async () => {
    const { call, create } = setup()
    const result = (await (await call('', create)).json()) as ResearchWriteResult
    if (!result.ok) throw new Error(result.message)
    for (const action of ['approve', 'revoke']) {
      const response = await call(`/${result.campaign.id}/${action}`, {
        actor: { kind: 'human' },
        token: 'application-token',
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'human_identity_unavailable' })
    }
    expect(
      (
        await call(`/${result.campaign.id}/proposals`, {
          idempotencyKey: 'fake-human',
          expectedVersion: 1,
          command: {
            kind: 'approve',
            reviewer: { reviewerId: 'human', proofId: 'fake', verifiedAt: Date.now() },
          },
        })
      ).status,
    ).toBe(400)
  })

  test('workspace isolation and malformed proposal validation', async () => {
    const { call, create, deps } = setup()
    const result = (await (await call('', create)).json()) as ResearchWriteResult
    if (!result.ok) throw new Error(result.message)
    expect(
      (await call(`/${result.campaign.id}`, undefined, { ...deps, workspaceId: 'other' })).status,
    ).toBe(404)
    expect((await call('', create, { ...deps, workspaceId: 'other' })).status).toBe(404)
    for (const command of [
      { kind: 'setBudget' },
      { kind: 'recordArtifact' },
      { kind: 'setInputs', inputs: [] },
    ]) {
      expect(
        (
          await call(`/${result.campaign.id}/proposals`, {
            idempotencyKey: 'bad',
            expectedVersion: 1,
            command,
          })
        ).status,
      ).toBe(400)
    }
    expect((await call('', { ...create, actor: { kind: 'human' } })).status).toBe(400)
  })

  test('projects durable notification receipts without exposing adapter configuration', async () => {
    const { call, create, deps } = setup()
    const result = (await (await call('', create)).json()) as ResearchWriteResult
    if (!result.ok) throw new Error(result.message)
    const response = await call(`/${result.campaign.id}/notifications`, undefined, {
      ...deps,
      researchNotifications: {
        publish: () => {},
        list: (campaignId: string) =>
          campaignId === result.campaign.id
            ? [
                {
                  eventId: 'event-1',
                  kind: 'completed',
                  channel: 'administrator',
                  status: 'delivered',
                  attempts: 1,
                  nextAttemptAt: null,
                  deliveredAt: 1,
                  lastError: null,
                  createdAt: 1,
                },
              ]
            : [],
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      notifications: [
        {
          eventId: 'event-1',
          kind: 'completed',
          channel: 'administrator',
          status: 'delivered',
          attempts: 1,
          nextAttemptAt: null,
          deliveredAt: 1,
          lastError: null,
          createdAt: 1,
        },
      ],
    })
  })
})
