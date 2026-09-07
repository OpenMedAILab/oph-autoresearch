import { canonicalResearchBundle, type ResearchCampaign } from '@oph-autoresearch/core'
import { getResearchCampaign, type Store } from '@oph-autoresearch/store'
import { canonicalJson, sha256 } from './skill-lock.ts'

/** Unit-test evidence fixture only: not a real model review or an execution/admission path. */
export function installSupportedReviewFixture(store: Store, campaign: ResearchCampaign) {
  const artifactVersionIds = campaign.artifactVersions.map((artifact) => artifact.id)
  const text = JSON.stringify({
    decision: 'supported',
    claims: [
      {
        claim: 'This deterministic fixture supports only the tested synthetic summary.',
        artifactVersionIds,
      },
    ],
    limitations: ['Unit-test review fixture; no model or scientific validation was performed.'],
  })
  const snapshot: ResearchCampaign = {
    ...campaign,
    modelReviews: [
      {
        id: 'rmr_fixture',
        dispatchKey: 'fixture-review',
        approvalId: 'hap_fixture',
        evidencePackHash: sha256('fixture-evidence'),
        configHash: sha256('fixture-config'),
        artifactVersionIds,
        currency: campaign.budget.currency,
        reservedCost: 1,
        maxRequests: 2,
        maxOutputTokens: 1024,
        requestCount: 1,
        status: 'done',
        ownerPid: process.pid,
        sourceContextHash: sha256(
          canonicalJson({
            context: sha256(
              canonicalJson({
                policy: campaign.policy,
                inputs: campaign.inputs,
                budget: campaign.budget,
              }),
            ),
            literatureCitations: campaign.literatureCitations ?? [],
          }),
        ),
        text,
        contentHash: sha256(text),
        actualCost: null,
      },
    ],
  }
  snapshot.bundleHash = sha256(canonicalResearchBundle(snapshot))
  store.db
    .query('UPDATE research_campaigns SET snapshot=? WHERE id=?')
    .run(JSON.stringify(snapshot), snapshot.id)
  return getResearchCampaign(store, snapshot.id)!
}
