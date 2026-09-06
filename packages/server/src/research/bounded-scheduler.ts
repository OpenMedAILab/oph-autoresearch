import {
  type ConversationId,
  canonicalResearchControllerBasis,
  type ResearchCampaign,
} from '@oph-autoresearch/core'
import {
  canStartControllerRequest,
  getResearchCampaign,
  hasSupportedReleaseReview,
  listResearchCampaigns,
  listWorkspaces,
  mutateResearchCampaign,
  type Store,
} from '@oph-autoresearch/store'
import { canonicalJson, sha256 } from './skill-lock.ts'

type Decision = 'start' | 'remote' | 'human' | 'change' | 'unknown' | 'finish' | 'idle'
/** Pure scheduling projection; it never sends, signs, quotes, or mutates a campaign. */
export function boundedControllerDecision(campaign: ResearchCampaign, now = Date.now()): Decision {
  const control = campaign.progressControl
  const reservation = campaign.controllerReservations?.find(
    (item) => item.id === control?.reservationRef,
  )
  if (
    control?.mode !== 'bounded' ||
    control.state === 'held' ||
    !reservation ||
    reservation.status === 'completed'
  )
    return 'idle'
  if (reservation.round && !reservation.round.finishedAt && reservation.round.expiresAt > now)
    return 'idle'
  if (
    reservation.requests.some((item) => item.status === 'sending' || item.status === 'unknown') ||
    campaign.attempts.some((item) => item.status === 'unknown')
  )
    return 'unknown'
  if (
    campaign.attempts.some((item) => item.status === 'running') ||
    campaign.modelReviews?.some((item) => item.status === 'reserved' || item.status === 'running')
  )
    return 'remote'
  const stopReached =
    reservation.limits.stopAfter === 'candidate'
      ? campaign.cliPreparations?.some((item) => item.status === 'candidate')
      : campaign.modelReviews?.some((review) =>
          hasSupportedReleaseReview(campaign, review.artifactVersionIds),
        )
  if (
    stopReached ||
    reservation.limits.deadlineAt <= now ||
    reservation.requests.length >= reservation.limits.maxModelRequests ||
    reservation.advancesUsed >= reservation.limits.maxAdvances ||
    control.state === 'exhausted'
  )
    return 'finish'
  const usable = (kind: string, key?: string) =>
    campaign.approvals.some(
      (item) =>
        item.status === 'active' &&
        !item.consumedBy &&
        item.bundleHash === campaign.bundleHash &&
        item.scope?.kind === kind &&
        item.scope.expiresAt > now &&
        (!key || item.scope.dispatchKey === key),
    )
  if (
    campaign.cliPreparations?.some(
      (item) => item.status === 'proposed' && !usable('cli_preparation', item.dispatchKey),
    )
  )
    return 'human'
  if (
    campaign.artifactVersions.some((item) => item.validation) &&
    reservation.limits.stopAfter === 'review' &&
    !usable('model_review')
  )
    return 'human'
  if (!canStartControllerRequest(campaign, reservation.id, control.generation, now)) return 'human'
  if (
    reservation.round?.generation === control.generation &&
    reservation.round.basisHash === sha256(canonicalResearchControllerBasis(campaign)) &&
    reservation.requests.length > reservation.round.requestCountAtStart
  )
    return 'change'
  return 'start'
}

/** Persistent counters/round claims live in Store. This timer only reacts to changed ready work. */
export function createBoundedScheduler(input: {
  store: Store
  isBusy: (id: ConversationId) => boolean
  startRun: (id: ConversationId, prompt: string) => void
  changed: () => void
  intervalMs?: number
  onError?: (error: unknown) => void
}) {
  let closed = false
  function tick() {
    if (closed) return
    for (const workspace of listWorkspaces(input.store))
      for (const original of listResearchCampaigns(input.store, workspace.id)) {
        if (input.isBusy(original.parentConversationId as ConversationId)) continue
        const campaign = getResearchCampaign(input.store, original.id)
        if (!campaign) continue
        const decision = boundedControllerDecision(campaign)
        const control = campaign.progressControl
        const reservation = campaign.controllerReservations?.find(
          (item) => item.id === control?.reservationRef,
        )
        if (!reservation || !control || decision === 'idle') continue
        try {
          if (decision === 'start') {
            input.startRun(
              campaign.parentConversationId as ConversationId,
              '继续已批准的有界研究推进。先读取最新研究状态，沿现有提案和运行继续；不得重投状态未知任务。遇到人类审批或远端尚未结束时停止本轮，由调度器等待事实更新。',
            )
          } else if (decision === 'finish') {
            const result = mutateResearchCampaign(input.store, campaign.id, {
              expectedVersion: campaign.version,
              idempotencyKey: `controller-terminal:${reservation.id}:${control.generation}`,
              command: {
                kind: 'completeBoundedResearch',
                reservationId: reservation.id,
                generation: control.generation,
              },
            })
            if (result.ok) input.changed()
          } else if (control.state === 'active' && reservation.waiting !== decision) {
            const result = mutateResearchCampaign(input.store, campaign.id, {
              expectedVersion: campaign.version,
              idempotencyKey: `controller-wait:${reservation.id}:${sha256(canonicalJson({ generation: control.generation, decision, version: campaign.version }))}`,
              command: {
                kind: 'waitController',
                reservationId: reservation.id,
                generation: control.generation,
                reason: decision,
              },
            })
            if (result.ok) input.changed()
          }
        } catch (error) {
          input.onError?.(error)
        }
      }
  }
  const timer = setInterval(tick, input.intervalMs ?? 1000)
  timer.unref()
  queueMicrotask(tick)
  return {
    tick,
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}
