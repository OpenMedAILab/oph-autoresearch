import {
  buildAdapter,
  computeCost,
  type LlmAdapter,
  type ProviderProfile,
} from '@oph-autoresearch/ai'
import type {
  ResearchCampaign,
  ResearchCommand,
  ResearchControllerLimits,
  ResearchControlPort,
} from '@oph-autoresearch/core'
import { canonicalResearchControllerBasis } from '@oph-autoresearch/core'
import {
  type ModelRef,
  makeResearchRequestGuard,
  type OphConfig,
  type ResearchRequestGuard,
  resolveModel,
} from '@oph-autoresearch/runtime'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { evidenceBudget } from './evidence-budget.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

export function quoteBoundedController(
  config: OphConfig,
  campaign: ResearchCampaign,
  limits: ResearchControllerLimits,
  target?: string | ModelRef,
) {
  if (
    !Number.isSafeInteger(limits.maxAdvances) ||
    limits.maxAdvances < 1 ||
    limits.maxAdvances > 50 ||
    !Number.isSafeInteger(limits.maxModelRequests) ||
    limits.maxModelRequests < 1 ||
    limits.maxModelRequests > 50 ||
    !Number.isSafeInteger(limits.deadlineAt) ||
    limits.deadlineAt <= Date.now() ||
    limits.deadlineAt > Date.now() + 24 * 60 * 60_000 ||
    !['candidate', 'review'].includes(limits.stopAfter)
  )
    throw new Error('主控推进必须设置有效的次数、截止时间和停止阶段')
  const resolved = resolveModel(config, target)
  if (!resolved) throw new Error('主控模型尚未配置')
  const profile: ProviderProfile = {
    kind: resolved.kind,
    model: resolved.model,
    apiKey: resolved.apiKey ?? '',
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    ...(resolved.spec ? { spec: resolved.spec } : {}),
    ...(resolved.transport ? { transport: resolved.transport } : {}),
  }
  const spec = buildAdapter(profile).spec
  const budget = evidenceBudget({
    profile,
    spec,
    currency: campaign.budget.currency,
    maxRequests: limits.maxModelRequests,
    maxOutputTokens: limits.maxOutputTokens,
  })
  const safeInput = Math.min(1_000_000, Math.floor(budget.maxInputTokens / 4) - 4096)
  if (
    !Number.isSafeInteger(limits.maxInputCharacters) ||
    limits.maxInputCharacters < 1 ||
    limits.maxInputCharacters > 1_000_000 ||
    safeInput < 1
  )
    throw new Error('主控输入长度超过已预留的模型上下文')
  limits = { ...limits, maxInputCharacters: Math.min(limits.maxInputCharacters, safeInput) }
  return {
    ...budget,
    configHash: sha256(
      canonicalJson({
        schema: 'bounded-controller-v1',
        configHash: budget.configHash,
        provider: resolved.provider,
        effort: resolved.effort ?? null,
        limits,
      }),
    ),
    limits,
    model: resolved.model,
    provider: resolved.provider,
    spec,
  }
}

const READ_ONLY = new Set([
  'status',
  'events',
  'next_actions',
  'receipt',
  'documents/read',
  'cli_preparation/status',
  'cli_preparation/catalog',
  'cancel',
  'reconcile',
  'cli_preparation/cancel',
  'cli_preparation/reconcile',
])

/** Each adapter call, including compaction, claims one durable request before transport. */
export function createBoundedController(input: {
  store: Store
  config: OphConfig
  campaignId: string
  target?: string | ModelRef
  port: ResearchControlPort
  changed: () => void
}) {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  const control = campaign?.progressControl
  const reservation = campaign?.controllerReservations?.find(
    (item) => item.id === control?.reservationRef,
  )
  if (
    !campaign ||
    control?.mode !== 'bounded' ||
    control.state !== 'active' ||
    !reservation ||
    reservation.status !== 'active'
  )
    throw new Error('当前没有有效的主控推进预留')
  const quote = quoteBoundedController(input.config, campaign, reservation.limits, input.target)
  if (
    quote.configHash !== reservation.configHash ||
    quote.reservedCost !== reservation.reservedCost ||
    quote.currency !== reservation.currency
  )
    throw new Error('主控模型或限额已变化，请重新批准')
  const generation = control.generation
  function mutate(command: ResearchCommand, key: string) {
    const current = getResearchCampaign(input.store, input.campaignId)
    if (!current) throw new Error('研究项目已不可用')
    const result = mutateResearchCampaign(input.store, current.id, {
      expectedVersion: current.version,
      idempotencyKey: key,
      command,
    })
    if (!result.ok) throw new Error(result.message)
    input.changed()
    return result.campaign
  }
  const roundId = `controller-round-${crypto.randomUUID()}`
  mutate(
    {
      kind: 'claimControllerRound',
      reservationId: reservation.id,
      generation,
      roundId,
      basisHash: sha256(canonicalResearchControllerBasis(campaign)),
      expiresAt: Date.now() + 30000,
    },
    `controller-round:${roundId}`,
  )
  let closed = false
  const heartbeat = setInterval(() => {
    if (closed) return
    try {
      mutate(
        {
          kind: 'renewControllerRound',
          reservationId: reservation.id,
          roundId,
          expiresAt: Date.now() + 30000,
        },
        `controller-heartbeat:${roundId}:${Date.now()}`,
      )
    } catch {
      closed = true
      clearInterval(heartbeat)
    }
  }, 10000)
  heartbeat.unref()
  function assertRound() {
    const latest = getResearchCampaign(input.store, input.campaignId)?.controllerReservations?.find(
      (item) => item.id === reservation!.id,
    )?.round
    if (closed || latest?.id !== roundId || latest.finishedAt || latest.expiresAt <= Date.now())
      throw new Error('本轮主控持有权已结束')
  }
  const inner = makeResearchRequestGuard({
    maxRequests: reservation.limits.maxModelRequests,
    maxOutputTokens: reservation.limits.maxOutputTokens,
    maxInputCharacters: reservation.limits.maxInputCharacters,
    beforeSend(requestId) {
      assertRound()
      mutate(
        { kind: 'startControllerRequest', reservationId: reservation.id, requestId, generation },
        `controller-send:${requestId}`,
      )
    },
    onSettled(requestId, result) {
      const usage = result.usage
      const measured =
        usage?.source === 'provider' &&
        [
          usage.inputTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.cachedTokens ?? 0,
          usage.cacheWriteTokens ?? 0,
        ].every((value) => Number.isFinite(value) && value >= 0)
      const amount = measured ? computeCost(quote.spec, usage!) : null
      mutate(
        {
          kind: 'finishControllerRequest',
          reservationId: reservation.id,
          requestId,
          actualCost: amount !== null && Number.isFinite(amount) ? amount : null,
          completed: result.completed,
        },
        `controller-finish:${requestId}`,
      )
    },
  })
  const guard: ResearchRequestGuard = {
    wrap(adapter: LlmAdapter) {
      if (
        adapter.kind !== quote.spec.provider ||
        canonicalJson(adapter.spec) !== canonicalJson(quote.spec)
      )
        throw new Error('隐式模型调用与批准的主控不一致')
      return inner.wrap(adapter)
    },
  }
  const port: ResearchControlPort = {
    async execute(request) {
      if (request.campaignId !== campaign.id)
        return { ok: false, status: 403, data: { error: '本次推进仅限已批准的研究项目' } }
      if (!READ_ONLY.has(request.operation)) {
        assertRound()
        const actionKey = sha256(canonicalJson(request))
        try {
          mutate(
            {
              kind: 'reserveControllerAdvance',
              reservationId: reservation.id,
              generation,
              actionKey,
            },
            `controller-advance:${reservation.id}:${actionKey}`,
          )
        } catch (error) {
          return {
            ok: false,
            status: 409,
            data: { error: error instanceof Error ? error.message : '推进限额已耗尽' },
          }
        }
      }
      return input.port.execute(request)
    },
  }
  return {
    guard,
    port,
    reservation,
    generation,
    finish() {
      clearInterval(heartbeat)
      if (closed) return
      closed = true
      mutate(
        { kind: 'finishControllerRound', reservationId: reservation.id, roundId },
        `controller-round-finish:${roundId}`,
      )
    },
  }
}
