/** Coverage: research.ts canonical approval bundles and event-ledger replay. */

import { describe, expect, test } from 'bun:test'
import {
  canonicalResearchBundle,
  foldResearchEvents,
  type ResearchCampaign,
  type ResearchEvent,
} from './research.ts'

function campaign(version = 1): ResearchCampaign {
  return {
    id: 'rc_1',
    workspaceId: 'ws_1',
    parentConversationId: 'cv_1',
    goal: 'validate a biomarker',
    stage: 'question',
    status: 'proposal',
    version,
    policy: { cohort: { minimum: 20 }, blinded: true },
    inputs: { modality: 'OCT' },
    budget: { currency: 'USD', limit: 100 },
    artifactVersions: [],
    approvals: [],
    taskRevisions: [],
    attempts: [],
    bundleHash: 'sha256:bundle',
    createdAt: 1,
    updatedAt: version,
  }
}

describe('research domain', () => {
  test('canonical bundle is independent of object insertion order', () => {
    const left = campaign()
    const right = campaign()
    right.policy = { blinded: true, cohort: { minimum: 20 } }
    expect(canonicalResearchBundle(left)).toBe(canonicalResearchBundle(right))
  })

  test('replay rejects a missing event before exposing a projection', () => {
    const first: ResearchEvent = {
      id: 're_1',
      campaignId: 'rc_1',
      sequence: 1,
      type: 'created',
      command: null,
      campaign: campaign(),
      occurredAt: 1,
    }
    const broken = { ...first, id: 're_3', sequence: 3, campaign: campaign(3) }
    expect(() => foldResearchEvents([first, broken])).toThrow(/broken event sequence/)
  })

  test('legacy events without synthetic arrays keep their established approval bundle bytes', () => {
    const current = campaign()
    const legacy = { ...current } as Partial<ResearchCampaign>
    delete legacy.taskRevisions
    delete legacy.attempts
    const event: ResearchEvent = {
      id: 're_legacy',
      campaignId: current.id,
      sequence: 1,
      type: 'created',
      command: null,
      campaign: legacy as ResearchCampaign,
      occurredAt: 1,
    }
    expect(canonicalResearchBundle(foldResearchEvents([event])!)).toBe(
      canonicalResearchBundle(current),
    )
  })
})
