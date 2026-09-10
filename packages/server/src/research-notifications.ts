import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { ResearchEvent, WorkflowCheckpointDetails } from '@oph-autoresearch/core'
import { parseModelReview } from './research/review-contract.ts'

export type ResearchNotificationKind =
  | 'human_checkpoint'
  | 'job_finished'
  | 'approval_needed'
  | 'failure'
  | 'unknown'
  | 'cancel_pending'
  | 'completed'
  | 'review_insufficient'
  | 'review_failed'

export interface ResearchNotificationPayload {
  schema: 'research-notification-v1'
  /** Stable external idempotency key for this event/channel/recipient delivery. */
  deliveryKey: string
  eventId: string
  campaignId: string
  campaignSeq: number
  occurredAt: number
  kind: ResearchNotificationKind
  campaign: { id: string; workspaceId: string; stage: string; status: string }
  conversationId?: string
  workflow?: {
    workflowId: string
    checkpointId: string
    conversationId: string
    reviewStepId: string
  }
  job?: { state: 'completed' | 'failed' | 'unknown'; reason?: string }
  checkpointDetails?: WorkflowCheckpointDetails
}

/**
 * A channel is inert unless the administrator explicitly sets enabled.  The
 * adapter is injected at service construction; endpoints and credentials never
 * enter the durable queue or its API projection.
 */
export interface ResearchNotificationAdapter {
  channel: string
  recipient: string
  enabled?: boolean
  accepts?(payload: ResearchNotificationPayload): boolean
  /**
   * Delivery is at-least-once. Persist deliveryKey at the external provider so
   * a provider acknowledgement lost before our local receipt commit is deduped.
   */
  deliver(input: {
    deliveryKey: string
    payload: ResearchNotificationPayload
    signal: AbortSignal
  }): Promise<void>
}

export interface ResearchNotificationConfig {
  /** Separate from the research ledger and internal outbox database. */
  ownDbPath: string
  adapters?: readonly ResearchNotificationAdapter[]
  maxAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  deliveryTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
}

export interface ResearchNotificationReceipt {
  eventId: string
  kind: ResearchNotificationKind
  channel: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  nextAttemptAt: number | null
  deliveredAt: number | null
  lastError: string | null
  createdAt: number
}

function validText(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
}

function notificationKind(event: ResearchEvent): ResearchNotificationKind | null {
  switch (event.type) {
    case 'declareSyntheticTask':
      return 'approval_needed'
    case 'failSynthetic':
    case 'interruptSynthetic':
      return 'failure'
    case 'markSyntheticUnknown':
      return 'unknown'
    case 'requestCancelSynthetic':
      return 'cancel_pending'
    case 'finishSynthetic':
      return 'completed'
    case 'finishModelReview': {
      const command = event.command
      if (command?.kind !== 'finishModelReview') return null
      if (command.status === 'failed') return 'review_failed'
      if (command.status === 'unknown') return 'unknown'
      const review = event.campaign.modelReviews?.find(
        (candidate) => candidate.id === command.reviewId,
      )
      if (!review) return null
      try {
        return parseModelReview(command.text, review.artifactVersionIds).decision === 'insufficient'
          ? 'review_insufficient'
          : null
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

function payloadFor(
  event: ResearchEvent,
  kind: ResearchNotificationKind,
  deliveryKey: string,
): ResearchNotificationPayload {
  return {
    schema: 'research-notification-v1',
    deliveryKey,
    eventId: event.id,
    campaignId: event.campaignId,
    conversationId: event.campaign.parentConversationId,
    campaignSeq: event.sequence,
    occurredAt: event.occurredAt,
    kind,
    // Do not include policy, inputs, goal, artifacts, approval proofs, text, or
    // any other research-health information in an external notification.
    campaign: {
      id: event.campaign.id,
      workspaceId: event.campaign.workspaceId,
      stage: event.campaign.stage,
      status: event.campaign.status,
    },
  }
}

function deliveryKey(eventId: string, channel: string, recipient: string): string {
  return `research-notification-v1:${createHash('sha256')
    .update(JSON.stringify([eventId, channel, recipient]))
    .digest('hex')}`
}

function sanitizedError(): string {
  // Delivery adapters may put credentials or endpoint URLs into Error.message.
  // The durable receipt deliberately retains only a stable, non-sensitive code.
  return 'delivery_failed'
}

export class ResearchNotificationCoordinator {
  private readonly db: Database
  private readonly adapters: ReadonlyMap<string, ResearchNotificationAdapter>
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly deliveryTimeoutMs: number
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval>
  private delivering = false
  private closed = false
  private activeAbort: AbortController | null = null

  constructor(config: ResearchNotificationConfig) {
    if (!Number.isSafeInteger(config.maxAttempts ?? 3) || (config.maxAttempts ?? 3) < 1)
      throw new Error('invalid notification maxAttempts')
    if (!Number.isSafeInteger(config.retryBaseMs ?? 1_000) || (config.retryBaseMs ?? 1_000) < 1)
      throw new Error('invalid notification retryBaseMs')
    if (!Number.isSafeInteger(config.retryMaxMs ?? 60_000) || (config.retryMaxMs ?? 60_000) < 1)
      throw new Error('invalid notification retryMaxMs')
    if (
      !Number.isSafeInteger(config.deliveryTimeoutMs ?? 5_000) ||
      (config.deliveryTimeoutMs ?? 5_000) < 1
    )
      throw new Error('invalid notification deliveryTimeoutMs')
    if (
      !Number.isSafeInteger(config.pollIntervalMs ?? 1_000) ||
      (config.pollIntervalMs ?? 1_000) < 1
    )
      throw new Error('invalid notification pollIntervalMs')
    this.maxAttempts = config.maxAttempts ?? 3
    this.retryBaseMs = config.retryBaseMs ?? 1_000
    this.retryMaxMs = config.retryMaxMs ?? 60_000
    this.deliveryTimeoutMs = config.deliveryTimeoutMs ?? 5_000
    this.now = config.now ?? Date.now
    const enabled = (config.adapters ?? []).filter(
      (adapter) =>
        adapter.enabled === true && validText(adapter.channel) && adapter.recipient.length > 0,
    )
    this.adapters = new Map(
      enabled.map((adapter) => [`${adapter.channel}\u0000${adapter.recipient}`, adapter]),
    )
    this.db = new Database(config.ownDbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS research_notifications (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        recipient TEXT NOT NULL,
        delivery_key TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(event_id, channel, recipient)
      );
      CREATE INDEX IF NOT EXISTS idx_research_notifications_due
        ON research_notifications(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_research_notifications_campaign
        ON research_notifications(campaign_id, id);`,
    )
    const columns = this.db.query('PRAGMA table_info(research_notifications)').all() as {
      name: string
    }[]
    if (!columns.some((column) => column.name === 'delivery_key')) {
      this.db.exec('ALTER TABLE research_notifications ADD COLUMN delivery_key TEXT')
      const legacy = this.db
        .query(
          'SELECT id,event_id,channel,recipient,payload FROM research_notifications WHERE delivery_key IS NULL',
        )
        .all() as {
        id: number
        event_id: string
        channel: string
        recipient: string
        payload: string
      }[]
      for (const row of legacy) {
        const key = deliveryKey(row.event_id, row.channel, row.recipient)
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        this.db
          .query('UPDATE research_notifications SET delivery_key=?, payload=? WHERE id=?')
          .run(key, JSON.stringify({ ...payload, deliveryKey: key }), row.id)
      }
    }
    this.timer = setInterval(() => void this.deliverDue(), config.pollIntervalMs ?? 1_000)
  }

  /** Stores one row per durable event/channel/recipient. Returns rows newly queued. */
  record(event: ResearchEvent): number {
    const kind = notificationKind(event)
    if (!kind || this.adapters.size === 0) return 0
    return this.recordPayload(payloadFor(event, kind, ''))
  }

  publishOperational(
    input: Pick<
      ResearchNotificationPayload,
      | 'eventId'
      | 'campaignId'
      | 'occurredAt'
      | 'kind'
      | 'campaign'
      | 'conversationId'
      | 'workflow'
      | 'job'
      | 'checkpointDetails'
    >,
  ): void {
    this.recordPayload({
      ...input,
      schema: 'research-notification-v1',
      deliveryKey: '',
      campaignSeq: 0,
    })
    void this.deliverDue()
  }

  private recordPayload(input: ResearchNotificationPayload): number {
    const now = this.now()
    let inserted = 0
    for (const adapter of this.adapters.values()) {
      if (adapter.accepts && !adapter.accepts(input)) continue
      const key = deliveryKey(input.eventId, adapter.channel, adapter.recipient)
      const payload = JSON.stringify({ ...input, deliveryKey: key })
      const result = this.db
        .query(
          `INSERT INTO research_notifications
            (event_id,campaign_id,kind,channel,recipient,delivery_key,payload,status,attempts,next_attempt_at,delivered_at,last_error,created_at)
           VALUES (?,?,?,?,?,?,?, 'pending', 0, ?, NULL, NULL, ?)
           ON CONFLICT(event_id,channel,recipient) DO NOTHING`,
        )
        .run(
          input.eventId,
          input.campaignId,
          input.kind,
          adapter.channel,
          adapter.recipient,
          key,
          payload,
          now,
          now,
        )
      inserted += result.changes
    }
    return inserted
  }

  /** Called after the internal event bus delivery; external delivery is independent. */
  publish(event: ResearchEvent): void {
    this.record(event)
    void this.deliverDue()
  }

  /** Replays the immutable ledger on startup to repair any publish/enqueue crash gap. */
  reconcile(events: readonly ResearchEvent[]): number {
    let inserted = 0
    for (const event of events) inserted += this.record(event)
    void this.deliverDue()
    return inserted
  }

  list(campaignId: string): ResearchNotificationReceipt[] {
    return this.db
      .query(
        `SELECT event_id,kind,channel,status,attempts,next_attempt_at,delivered_at,last_error,created_at
         FROM research_notifications WHERE campaign_id=? ORDER BY id`,
      )
      .all(campaignId)
      .map((row) => {
        const value = row as Record<string, unknown>
        return {
          eventId: String(value.event_id),
          kind: value.kind as ResearchNotificationKind,
          channel: String(value.channel),
          status: value.status as ResearchNotificationReceipt['status'],
          attempts: Number(value.attempts),
          nextAttemptAt: typeof value.next_attempt_at === 'number' ? value.next_attempt_at : null,
          deliveredAt: typeof value.delivered_at === 'number' ? value.delivered_at : null,
          lastError: typeof value.last_error === 'string' ? value.last_error : null,
          createdAt: Number(value.created_at),
        }
      })
  }

  async deliverDue(): Promise<void> {
    if (this.closed || this.delivering || this.adapters.size === 0) return
    this.delivering = true
    try {
      while (!this.closed) {
        const now = this.now()
        const adapterPairs = [...this.adapters.values()].flatMap((adapter) => [
          adapter.channel,
          adapter.recipient,
        ])
        const eligible = [...this.adapters.values()]
          .map(() => '(channel=? AND recipient=?)')
          .join(' OR ')
        const row = this.db
          .query(
            `SELECT id,channel,recipient,delivery_key,payload,attempts FROM research_notifications
             WHERE status='pending' AND next_attempt_at <= ? AND (${eligible}) ORDER BY id LIMIT 1`,
          )
          .get(now, ...adapterPairs) as {
          id: number
          channel: string
          recipient: string
          delivery_key: string
          payload: string
          attempts: number
        } | null
        if (!row) return
        const adapter = this.adapters.get(`${row.channel}\u0000${row.recipient}`)
        if (!adapter) continue
        try {
          const controller = new AbortController()
          this.activeAbort = controller
          let timeout: ReturnType<typeof setTimeout> | undefined
          const aborted = new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('delivery_aborted')),
              {
                once: true,
              },
            ),
          )
          const timedOut = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort()
              reject(new Error('delivery_timeout'))
            }, this.deliveryTimeoutMs)
          })
          try {
            await Promise.race([
              adapter.deliver({
                deliveryKey: row.delivery_key,
                payload: JSON.parse(row.payload) as ResearchNotificationPayload,
                signal: controller.signal,
              }),
              aborted,
              timedOut,
            ])
          } finally {
            if (timeout) clearTimeout(timeout)
            if (this.activeAbort === controller) this.activeAbort = null
          }
          if (this.closed) return
          this.db
            .query(
              `UPDATE research_notifications
               SET status='delivered', attempts=attempts+1, delivered_at=?, next_attempt_at=?, last_error=NULL
               WHERE id=? AND status='pending'`,
            )
            .run(this.now(), Number.MAX_SAFE_INTEGER, row.id)
        } catch {
          if (this.closed) return
          const attempts = row.attempts + 1
          const failed = attempts >= this.maxAttempts
          const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempts - 1))
          this.db
            .query(
              `UPDATE research_notifications
               SET attempts=?, status=?, next_attempt_at=?, last_error=? WHERE id=? AND status='pending'`,
            )
            .run(
              attempts,
              failed ? 'failed' : 'pending',
              failed ? Number.MAX_SAFE_INTEGER : this.now() + delay,
              sanitizedError(),
              row.id,
            )
        }
      }
    } finally {
      this.delivering = false
    }
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
    this.activeAbort?.abort()
    this.db.close()
  }
}
