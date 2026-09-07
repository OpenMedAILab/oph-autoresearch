import { buildAdapter, type ProviderProfile } from '@oph-autoresearch/ai'
import type { ResearchCampaign } from '@oph-autoresearch/core'
import { makeResearchRequestGuard, type OphConfig, resolveModel } from '@oph-autoresearch/runtime'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { evidenceBudget } from './evidence-budget.ts'
import { runEvidenceCliReview } from './evidence-cli.ts'
import { buildEvidencePack, runEvidenceReview } from './evidence-session.ts'
import { parseModelReview } from './review-contract.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

interface ReviewInput {
  store: Store
  config: OphConfig
  workspaceRoot: string
  campaignId: string
  attemptIds: string[]
  cli?: { workerArgv?: readonly string[] }
}
async function prepare(input: ReviewInput) {
  const config = structuredClone(input.config)
  const resolved = resolveModel(config)
  if (!resolved) throw new Error('Review model is not configured')
  const profile: ProviderProfile = {
    kind: resolved.kind,
    model: resolved.model,
    apiKey: resolved.apiKey ?? '',
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    ...(resolved.spec ? { spec: resolved.spec } : {}),
    ...(resolved.transport ? { transport: resolved.transport } : {}),
  }
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) throw new Error('Unknown campaign')
  const budget = evidenceBudget({
    profile,
    spec: buildAdapter(profile).spec,
    currency: campaign.budget.currency,
    maxRequests: 2,
    maxOutputTokens: 1024,
  })
  if (budget.maxInputTokens <= 16384)
    throw new Error('Review context cannot hold the conservative input bound')
  const pack = await buildEvidencePack(
    input.store,
    input.workspaceRoot,
    campaign.id,
    input.attemptIds,
  )
  const quote = {
    ...budget,
    configHash: sha256(
      canonicalJson({
        configHash: budget.configHash,
        provider: config.active.provider,
        effort: resolved.effort ?? null,
        executionBackend: input.cli ? 'builtin-cli' : 'builtin-session',
      }),
    ),
    executionBackend: input.cli ? ('builtin-cli' as const) : ('builtin-session' as const),
    evidencePackHash: sha256(canonicalJson(pack)),
    artifactVersionIds: pack.artifactVersionIds,
    pricingBasis: 'configured-price-upper-reservation',
    usageIfMissing: 'reservation-retained',
  }
  return { config, quote, profile, pack }
}
export async function quoteEvidenceReview(input: ReviewInput) {
  return (await prepare(input)).quote
}

/** Actual consumer: atomically reserves approved budget before a fresh, strictly bounded Session. */
export async function executeEvidenceReview(
  input: ReviewInput & {
    expectedVersion: number
    dispatchKey: string
    approvalId: string
    signal: AbortSignal
    onChange?: (campaign: ResearchCampaign) => void
  },
) {
  const existing = getResearchCampaign(input.store, input.campaignId)?.modelReviews?.find(
    (r) => r.dispatchKey === input.dispatchKey,
  )
  if (existing) {
    const campaign = getResearchCampaign(input.store, input.campaignId)!
    const attempts = campaign.attempts
      .filter(
        (a) => a.artifactVersionId && existing.artifactVersionIds.includes(a.artifactVersionId),
      )
      .map((a) => a.id)
      .sort()
    if (
      existing.approvalId !== input.approvalId ||
      canonicalJson(attempts) !== canonicalJson([...input.attemptIds].sort())
    )
      throw new Error('Review dispatch key conflict')
    return { replayed: true, review: existing }
  }
  const { config, quote, profile, pack } = await prepare(input)
  const reserve = mutateResearchCampaign(input.store, input.campaignId, {
    expectedVersion: input.expectedVersion,
    idempotencyKey: `review-reserve:${input.dispatchKey}`,
    command: {
      kind: 'reserveModelReview',
      spec: {
        dispatchKey: input.dispatchKey,
        approvalId: input.approvalId,
        evidencePackHash: quote.evidencePackHash,
        configHash: quote.configHash,
        executionBackend: quote.executionBackend,
        artifactVersionIds: quote.artifactVersionIds,
        currency: quote.currency,
        reservedCost: quote.reservedCost,
        maxRequests: quote.maxRequests,
        maxOutputTokens: quote.maxOutputTokens,
      },
    },
  })
  if (!reserve.ok) throw new Error(reserve.message)
  const review = reserve.campaign.modelReviews!.find(
    (candidate) => candidate.dispatchKey === input.dispatchKey,
  )!
  if (reserve.replayed) return { replayed: true, review }
  input.onChange?.(reserve.campaign)
  const guard = makeResearchRequestGuard({
    maxRequests: quote.maxRequests,
    maxOutputTokens: quote.maxOutputTokens,
    // Four UTF-8 bytes per JS character plus ample provider framing headroom; reserve covers the whole configured context.
    maxInputCharacters: Math.min(1_000_000, Math.floor(quote.maxInputTokens / 4) - 4096),
    beforeSend: () => {
      const current = getResearchCampaign(input.store, input.campaignId)!
      const sent = mutateResearchCampaign(input.store, current.id, {
        expectedVersion: current.version,
        idempotencyKey: `review-send:${review.id}:${current.version}`,
        command: { kind: 'startModelReviewRequest', reviewId: review.id },
      })
      if (!sent.ok) throw new Error(sent.message)
      input.onChange?.(sent.campaign)
    },
  })
  let runId = '',
    conversationId = '',
    text = '',
    status: 'done' | 'failed' | 'unknown' = 'unknown',
    actualCost: number | null = null
  try {
    const result = input.cli
      ? await runEvidenceCliReview({
          pack,
          config,
          adapter: guard.wrap(buildAdapter(profile)),
          signal: input.signal,
          ...input.cli,
        })
      : await runEvidenceReview({ ...input, config, requestGuard: guard, maxSteps: 3 })
    runId = result.runId
    conversationId = result.conversationId
    text = result.text
    const currentPack = await buildEvidencePack(
      input.store,
      input.workspaceRoot,
      input.campaignId,
      input.attemptIds,
    )
    status =
      result.status === 'done' && sha256(canonicalJson(currentPack)) === quote.evidencePackHash
        ? 'done'
        : result.status === 'failed'
          ? 'failed'
          : 'unknown'
    if (status === 'done') {
      try {
        parseModelReview(text, quote.artifactVersionIds)
      } catch {
        status = 'failed'
      }
    }
    if (
      result.usage &&
      result.usage.turns.length > 0 &&
      result.usage.turns.every((turn) => turn.source === 'provider' && turn.usageStatus === 'ok')
    )
      actualCost = result.usage.cost
  } catch {
    status = 'unknown'
  }
  const current = getResearchCampaign(input.store, input.campaignId)!
  const finished = mutateResearchCampaign(input.store, current.id, {
    expectedVersion: current.version,
    idempotencyKey: `review-finish:${review.id}`,
    command: {
      kind: 'finishModelReview',
      reviewId: review.id,
      runId,
      conversationId,
      text,
      status,
      actualCost,
    },
  })
  if (!finished.ok) throw new Error(finished.message)
  input.onChange?.(finished.campaign)
  return {
    replayed: false,
    review: finished.campaign.modelReviews!.find((r) => r.id === review.id)!,
  }
}
