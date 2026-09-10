import type { ConversationId } from '@oph-autoresearch/core'
import { listConversationTree, listRuns, type Store } from '@oph-autoresearch/store'

/** Read-only rollup of run usage, including nested and archived members. No currency conversion. */
export function campaignUsage(store: Store, parentId: ConversationId) {
  const conversations = listConversationTree(store, parentId)
  const totals: Record<string, number> = {}
  let inputTokens = 0,
    outputTokens = 0,
    unavailableRuns = 0,
    runCount = 0
  for (const conversation of conversations)
    for (const run of listRuns(store, conversation.id)) {
      runCount++
      const usage = run.usage
      if (usage.reporting === 'unavailable' || usage.cost === null) {
        unavailableRuns++
        continue
      }
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      totals[usage.currency] = (totals[usage.currency] ?? 0) + usage.cost
    }
  return {
    conversationCount: conversations.length,
    runCount,
    inputTokens,
    outputTokens,
    costs: Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, cost]) => ({ currency, cost })),
    unavailableRuns,
    scope: 'parent-conversation-tree' as const,
  }
}
