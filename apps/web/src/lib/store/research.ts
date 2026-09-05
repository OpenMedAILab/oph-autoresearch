import type { AgentEvent } from '@oph-autoresearch/core'
import { createSignal } from 'solid-js'

const [changes, setChanges] = createSignal<Record<string, number>>({})
const [resync, setResync] = createSignal(0)
const sequences = new Map<string, number>()

export function researchRefreshVersion(workspaceId: string, conversationId: string): string {
  return `${resync()}:${changes()[`${workspaceId}:${conversationId}`] ?? 0}`
}

export function refreshResearchSnapshots(): void {
  setResync((version) => version + 1)
}

export function acceptResearchChanged(
  event: Extract<AgentEvent, { type: 'research.changed' }>,
): void {
  if (event.campaignSeq <= (sequences.get(event.campaignId) ?? 0)) return
  sequences.set(event.campaignId, event.campaignSeq)
  const key = `${event.workspaceId}:${event.parentConversationId}`
  setChanges((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
}
