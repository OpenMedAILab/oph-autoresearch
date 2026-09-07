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

  test('canonical bundle binds frozen CLI preparation fields but excludes delivery state', () => {
    const proposed: ResearchCampaign = {
      ...campaign(),
      cliPreparations: [
        {
          id: 'rcp_1',
          taskRevisionId: 'rtr_1',
          dispatchKey: 'prepare-1',
          candidateId: 'candidate_1',
          adapterId: 'local-fixture',
          adapterConfigHash: `sha256:${'c'.repeat(64)}`,
          backendPolicyHash: `sha256:${'d'.repeat(64)}`,
          model: 'fixture-model',
          instructions: 'prepare a candidate only',
          inputHash: `sha256:${'a'.repeat(64)}`,
          configHash: `sha256:${'b'.repeat(64)}`,
          deviceId: 'gpu-fixture-1',
          maxRuntimeMs: 60_000,
          maxCost: 12,
          acknowledgeUnknownCost: true,
          actualCost: null,
          status: 'proposed' as const,
          attemptId: null,
          artifactVersionId: null,
          createdAt: 1,
        },
      ],
    }
    const changedFrozen = structuredClone(proposed)
    changedFrozen.cliPreparations![0]!.instructions = 'a different approved instruction'
    const changedDeliveryState = structuredClone(proposed)
    changedDeliveryState.cliPreparations![0]!.status = 'candidate'
    changedDeliveryState.cliPreparations![0]!.attemptId = 'rat_1'
    changedDeliveryState.cliPreparations![0]!.artifactVersionId = 'rav_1'

    expect(canonicalResearchBundle(proposed)).not.toBe(canonicalResearchBundle(campaign()))
    expect(canonicalResearchBundle(changedFrozen)).not.toBe(canonicalResearchBundle(proposed))
    expect(canonicalResearchBundle(changedDeliveryState)).toBe(canonicalResearchBundle(proposed))
  })
})
