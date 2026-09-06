import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchEvent } from '@oph-autoresearch/core'
import {
  createConversation,
  createResearchCampaign,
  mutateResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from './bus.ts'
import { publishResearchEvents } from './research-events.ts'
import { ResearchNotificationCoordinator } from './research-notifications.ts'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function dbPath() {
  const root = await mkdtemp(join(tmpdir(), 'oph-research-notifications-'))
  roots.push(root)
  return join(root, 'notifications.sqlite')
}

function event(
  type: ResearchEvent['type'] = 'requestCancelSynthetic',
  id = 'event-1',
): ResearchEvent {
  const command =
    type === 'requestCancelSynthetic'
      ? { kind: type, attemptId: 'attempt-1' }
      : type === 'finishSynthetic'
        ? {
            kind: type,
            attemptId: 'attempt-1',
            contentHash: `sha256:${'a'.repeat(64)}`,
            uri: 'file:///result',
            artifactKind: 'synthetic',
            validation: {
              inputHash: `sha256:${'b'.repeat(64)}`,
              contentHash: `sha256:${'a'.repeat(64)}`,
              byteLength: 1,
              verifiedAt: 1,
            },
          }
        : type === 'setInputs'
          ? { kind: type, inputs: {} }
          : ({ kind: type } as never)
  return {
    id,
    campaignId: 'campaign-1',
    sequence: 1,
    type,
    command,
    occurredAt: 1,
    campaign: {
      id: 'campaign-1',
      workspaceId: 'workspace-1',
      stage: 'execution',
      status: 'active',
    } as ResearchEvent['campaign'],
  }
}

describe('durable research notifications', () => {
  test('deduplicates a relevant ledger event across restart and ignores non-notification events', async () => {
    const path = await dbPath()
    const adapter = { channel: 'admin', recipient: 'ops', enabled: true, deliver: async () => {} }
    const first = new ResearchNotificationCoordinator({ ownDbPath: path, adapters: [adapter] })
    expect(first.record(event())).toBe(1)
    expect(first.record(event())).toBe(0)
    expect(first.record(event('setInputs', 'event-ignored'))).toBe(0)
    expect(first.list('campaign-1')).toMatchObject([
      { eventId: 'event-1', kind: 'cancel_pending', status: 'pending', attempts: 0 },
    ])
    first.close()

    const restarted = new ResearchNotificationCoordinator({ ownDbPath: path, adapters: [adapter] })
    expect(restarted.reconcile([event()])).toBe(0)
    expect(restarted.list('campaign-1')).toHaveLength(1)
    restarted.close()
  })

  test('retries with bounded backoff and persists a sanitized delivered receipt', async () => {
    const path = await dbPath()
    let now = 1_000
    let calls = 0
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      now: () => now,
      retryBaseMs: 10,
      retryMaxMs: 20,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async () => {
            calls++
            if (calls === 1) throw new Error('https://secret.example/token=leak')
          },
        },
      ],
    })
    coordinator.record(event())
    await coordinator.deliverDue()
    expect(coordinator.list('campaign-1')).toMatchObject([
      {
        status: 'pending',
        attempts: 1,
        nextAttemptAt: 1_010,
        lastError: 'delivery_failed',
      },
    ])
    now = 1_009
    await coordinator.deliverDue()
    expect(calls).toBe(1)
    now = 1_010
    await coordinator.deliverDue()
    expect(coordinator.list('campaign-1')).toMatchObject([
      { status: 'delivered', attempts: 2, deliveredAt: 1_010, lastError: null },
    ])
    coordinator.close()
  })

  test('records a failed receipt after the bounded retry budget', async () => {
    const path = await dbPath()
    let now = 1
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      now: () => now,
      maxAttempts: 2,
      retryBaseMs: 5,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async () => Promise.reject(new Error('credential=secret')),
        },
      ],
    })
    coordinator.record(event())
    await coordinator.deliverDue()
    now = 6
    await coordinator.deliverDue()
    expect(coordinator.list('campaign-1')).toMatchObject([
      {
        status: 'failed',
        attempts: 2,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastError: 'delivery_failed',
      },
    ])
    coordinator.close()
  })

  test('does not queue or pretend to deliver without an explicitly enabled administrator adapter', async () => {
    const path = await dbPath()
    let calls = 0
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      adapters: [
        {
          channel: 'feishu',
          recipient: 'ops',
          deliver: async () => {
            calls++
          },
        },
      ],
    })
    expect(coordinator.record(event())).toBe(0)
    await coordinator.deliverDue()
    expect(calls).toBe(0)
    expect(coordinator.list('campaign-1')).toEqual([])
    coordinator.close()
  })

  test('skips a removed channel and delivers the next eligible channel', async () => {
    const path = await dbPath()
    const removed = new ResearchNotificationCoordinator({
      ownDbPath: path,
      adapters: [{ channel: 'removed', recipient: 'old', enabled: true, deliver: async () => {} }],
    })
    removed.record(event())
    removed.close()
    let delivered = 0
    const active = new ResearchNotificationCoordinator({
      ownDbPath: path,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'active',
          recipient: 'new',
          enabled: true,
          deliver: async () => {
            delivered++
          },
        },
      ],
    })
    active.record(event('requestCancelSynthetic', 'event-2'))
    await active.deliverDue()
    expect(delivered).toBe(1)
    expect(active.list('campaign-1')).toMatchObject([
      { eventId: 'event-1', channel: 'removed', status: 'pending' },
      { eventId: 'event-2', channel: 'active', status: 'delivered' },
    ])
    active.close()
  })

  test('times out and aborts a hung delivery, and close aborts an active delivery promptly', async () => {
    const path = await dbPath()
    let timedOutAbort = false
    const timed = new ResearchNotificationCoordinator({
      ownDbPath: path,
      deliveryTimeoutMs: 10,
      maxAttempts: 1,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async ({ signal }) => {
            signal.addEventListener('abort', () => {
              timedOutAbort = true
            })
            await new Promise(() => {})
          },
        },
      ],
    })
    timed.record(event())
    await timed.deliverDue()
    expect(timedOutAbort).toBe(true)
    expect(timed.list('campaign-1')).toMatchObject([{ status: 'failed', attempts: 1 }])
    timed.close()

    const closePath = await dbPath()
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const closing = new ResearchNotificationCoordinator({
      ownDbPath: closePath,
      deliveryTimeoutMs: 60_000,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async ({ signal }) => {
            started.resolve()
            signal.addEventListener('abort', () => aborted.resolve(), { once: true })
            await new Promise(() => {})
          },
        },
      ],
    })
    closing.record(event())
    const inFlight = closing.deliverDue()
    await started.promise
    closing.close()
    await Promise.all([inFlight, aborted.promise])
  })

  test('uses the same delivery key when an external acknowledgement is lost before the receipt commit', async () => {
    const path = await dbPath()
    let now = 1
    const keys: string[] = []
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      now: () => now,
      retryBaseMs: 1,
      pollIntervalMs: 60_000,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async ({ deliveryKey }) => {
            keys.push(deliveryKey)
            if (keys.length === 1)
              throw new Error('external provider accepted but response was lost')
          },
        },
      ],
    })
    coordinator.record(event())
    await coordinator.deliverDue()
    now = 2
    await coordinator.deliverDue()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(coordinator.list('campaign-1')).toMatchObject([{ status: 'delivered', attempts: 2 }])
    coordinator.close()
  })

  test('classifies only a valid completed insufficient review as review_insufficient', async () => {
    const path = await dbPath()
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      adapters: [{ channel: 'admin', recipient: 'ops', enabled: true, deliver: async () => {} }],
    })
    const review = {
      ...event('finishModelReview', 'review-insufficient'),
      command: {
        kind: 'finishModelReview',
        reviewId: 'review-1',
        runId: 'run-1',
        conversationId: 'conversation-1',
        text: JSON.stringify({ decision: 'insufficient', claims: [], limitations: [] }),
        status: 'done',
        actualCost: null,
      },
      campaign: {
        ...event().campaign,
        modelReviews: [{ id: 'review-1', artifactVersionIds: [] }],
      },
    } as ResearchEvent
    const failed = {
      ...review,
      id: 'review-failed',
      command: { ...review.command, status: 'failed' },
    } as ResearchEvent
    expect(coordinator.record(review)).toBe(1)
    expect(coordinator.record(failed)).toBe(1)
    expect(coordinator.list('campaign-1')).toMatchObject([
      { eventId: 'review-insufficient', kind: 'review_insufficient' },
      { eventId: 'review-failed', kind: 'review_failed' },
    ])
    coordinator.close()
  })

  test('records notification candidates from publishResearchEvents after internal outbox delivery', async () => {
    const path = await dbPath()
    const store = new Store({ path: ':memory:' })
    const workspace = upsertWorkspace(store, 'D:/notification-integration', 'notifications')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'test',
      model: 'test',
    })
    const created = createResearchCampaign(store, {
      idempotencyKey: 'create',
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'sensitive clinical objective',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 1 },
    })
    if (!created.ok) throw new Error(created.message)
    const declared = mutateResearchCampaign(store, created.campaign.id, {
      idempotencyKey: 'declare',
      expectedVersion: created.campaign.version,
      command: {
        kind: 'declareSyntheticTask',
        taskId: 'task-1',
        inputHash: `sha256:${'a'.repeat(64)}`,
        artifactVersionIds: [],
      },
    })
    if (!declared.ok) throw new Error(declared.message)
    const coordinator = new ResearchNotificationCoordinator({
      ownDbPath: path,
      adapters: [
        {
          channel: 'admin',
          recipient: 'ops',
          enabled: true,
          deliver: async () => new Promise(() => {}),
        },
      ],
    })
    try {
      expect(publishResearchEvents(store, new EventBus(), coordinator)).toBe(2)
      expect(coordinator.list(created.campaign.id)).toMatchObject([
        { kind: 'approval_needed', status: 'pending', attempts: 0 },
      ])
    } finally {
      coordinator.close()
      store.close()
    }
  })
})
