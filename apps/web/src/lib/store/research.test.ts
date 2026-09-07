import { expect, test } from 'bun:test'
import {
  acceptResearchChanged,
  refreshResearchSnapshots,
  researchRefreshVersion,
} from './research.ts'

test('campaign sequence deduplicates replay and never refreshes another scope', () => {
  const before = researchRefreshVersion('ws', 'parent')
  const other = researchRefreshVersion('other', 'parent')
  const event = {
    type: 'research.changed' as const,
    eventId: 'evt',
    campaignId: crypto.randomUUID(),
    campaignSeq: 2,
    workspaceId: 'ws',
    parentConversationId: 'parent',
  }
  acceptResearchChanged(event)
  const changed = researchRefreshVersion('ws', 'parent')
  expect(changed).not.toBe(before)
  acceptResearchChanged({ ...event, campaignSeq: 1 })
  acceptResearchChanged(event)
  expect(researchRefreshVersion('ws', 'parent')).toBe(changed)
  expect(researchRefreshVersion('other', 'parent')).toBe(other)
  refreshResearchSnapshots()
  expect(researchRefreshVersion('ws', 'parent')).not.toBe(changed)
})
