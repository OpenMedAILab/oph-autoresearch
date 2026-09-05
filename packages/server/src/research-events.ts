import type { ConversationId } from '@oph-autoresearch/core'
import { deliverResearchOutbox, type Store } from '@oph-autoresearch/store'
import type { EventBus } from './bus.ts'

export function publishResearchEvents(store: Store, bus: EventBus): number {
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
  })
}
