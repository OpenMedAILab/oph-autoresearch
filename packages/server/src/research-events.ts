import type { ConversationId } from '@oph-autoresearch/core'
import { deliverResearchOutbox, type Store } from '@oph-autoresearch/store'
import type { EventBus } from './bus.ts'
import type { ResearchNotificationCoordinator } from './research-notifications.ts'

export function publishResearchEvents(
  store: Store,
  bus: EventBus,
  notifications?: Pick<ResearchNotificationCoordinator, 'publish'>,
): number {
  return deliverResearchOutbox(store, (event) => {
    bus.publish(
      {
        type: 'research.changed',
        eventId: event.id,
        campaignId: event.campaignId,
        campaignSeq: event.sequence,
        workspaceId: event.campaign.workspaceId,
        parentConversationId: event.campaign.parentConversationId,
      },
      event.campaign.parentConversationId as ConversationId,
    )
    // Internal delivery remains the outbox acknowledgement authority. The
    // independent queue records after it, then repairs a crash gap by replaying
    // the immutable event ledger during service startup.
    notifications?.publish(event)
  })
}
