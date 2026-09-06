import type {
  FormalExecutionAuthorityBinding,
  FormalExecutionJobSpec,
  FormalExecutionPlan,
  ResearchCampaign,
  ResearchCommand,
} from '@oph-autoresearch/core'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import type { DurableJob } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

const HASH = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/
const EPOCH = /^[A-Za-z0-9_-]{16,128}$/
const ABSOLUTE_REMOTE_ROOT = /^\/(?:[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)?$/
const OBSERVER_LEASE_MS = 30_000

export interface FormalExecutionScope {
  workspaceId: string
  workspaceRoot: string
  campaignId: string
}
export interface FormalExecutionRoute {
  id: string
  profileId: string
  workspaceBindingHash?: string
  connectionHash: string
  remoteRoot: string
  authorityId: string
  admissionEvidenceHash: string
  /** Produced only after the administrator's actual Linux/rootless/cgroup-v2 probe. */
  admission: {
    schema: 'formal-rootless-oci-admission-v1'
    rootlessCgroupV2: true
    evidenceHash: string
  }
  maxCost: number
  authority: {
    identity(): Promise<{ schema: 'research-authority-identity-v1'; epoch: string }>
    submit(spec: FormalExecutionJobSpec, expectedEpoch: string): Promise<DurableJob>
    query(dispatchKey: string, expectedEpoch: string): Promise<DurableJob | null>
    cancel(dispatchKey: string, expectedEpoch: string): Promise<DurableJob | null>
    receipt(dispatchKey: string, expectedEpoch: string): Promise<Uint8Array>
    reconcileInterrupted(): Promise<readonly DurableJob[]>
    verifyReceipt(spec: FormalExecutionJobSpec, bytes: Uint8Array): Promise<boolean> | boolean
    /** Administrative staging receives exact bytes, never caller-supplied paths or argv. */
    registerCandidate(input: {
      candidateArtifactId: string
      code: Uint8Array
      codeHash: string
      candidateReceipt: Uint8Array
      candidateReceiptHash: string
    }): Promise<void>
  }
}
export interface FormalCandidateSource {
  read(
    plan: FormalExecutionPlan,
    campaign: ResearchCampaign,
  ): Promise<{
    code: Uint8Array
    candidateReceipt: Uint8Array
  }>
}
export class FormalExecutionControlError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

export class FormalExecutionController {
  private readonly observing = new Set<string>()
  private closed = false
  private readonly instanceId: string
  constructor(
    private readonly store: Store,
    private readonly routes: readonly FormalExecutionRoute[],
    private readonly candidates: FormalCandidateSource,
    private readonly changed: () => void,
    instanceId = `formal-observer-${crypto.randomUUID()}`,
  ) {
    if (
      !ID.test(instanceId) ||
      !routes.length ||
      new Set(routes.map((route) => route.id)).size !== routes.length ||
      routes.some(
        (route) =>
          route.admission?.schema !== 'formal-rootless-oci-admission-v1' ||
          route.admission.rootlessCgroupV2 !== true ||
          ![route.id, route.profileId, route.authorityId].every((value) => ID.test(value)) ||
          !ABSOLUTE_REMOTE_ROOT.test(route.remoteRoot) ||
          ![route.connectionHash, route.admissionEvidenceHash, route.admission.evidenceHash].every(
            (value) => HASH.test(value),
          ) ||
          route.admission.evidenceHash !== route.admissionEvidenceHash ||
          (route.workspaceBindingHash !== undefined && !HASH.test(route.workspaceBindingHash)) ||
          !Number.isFinite(route.maxCost) ||
          route.maxCost < 0,
      )
    )
      throw new Error('Invalid admitted formal execution route')
    this.instanceId = instanceId
  }
  close() {
    this.closed = true
  }
  private campaign(scope: FormalExecutionScope) {
    const campaign = getResearchCampaign(this.store, scope.campaignId)
    if (!campaign || campaign.workspaceId !== scope.workspaceId)
      throw new FormalExecutionControlError('研究项目不存在', 404)
    return campaign
  }
  private mutate(
    scope: FormalExecutionScope,
    idempotencyKey: string,
    command: ResearchCommand,
    expectedVersion = this.campaign(scope).version,
    notify = true,
  ) {
    const result = mutateResearchCampaign(this.store, scope.campaignId, {
      expectedVersion,
      idempotencyKey,
      command,
    })
    if (!result.ok) throw new FormalExecutionControlError(result.message)
    if (notify) this.changed()
    return result
  }
  private routeFor(plan: FormalExecutionPlan, routeId: string) {
    const route = this.routes.find(
      (item) =>
        item.id === routeId &&
        (item.workspaceBindingHash === undefined ||
          item.workspaceBindingHash === plan.workspaceBindingHash),
    )
    if (!route) throw new FormalExecutionControlError('正式执行路线未准入或工作区绑定不匹配', 400)
    return route
  }
  async submit(
    scope: FormalExecutionScope,
    input: {
      planId: string
      approvalId: string
      routeId: string
      expectedVersion: number
      idempotencyKey: string
    },
  ) {
    const before = this.campaign(scope)
    if (!IDEMPOTENCY.test(input.idempotencyKey))
      throw new FormalExecutionControlError('无效幂等键', 400)
    const plan = before.formalExecutionPlans?.find((item) => item.planId === input.planId)
    if (!plan) throw new FormalExecutionControlError('正式计划不存在', 404)
    const route = this.routeFor(plan, input.routeId)
    const identity = await route.authority.identity()
    if (identity.schema !== 'research-authority-identity-v1' || !EPOCH.test(identity.epoch))
      throw new FormalExecutionControlError('正式执行 authority 身份无效；不会投递')
    const { attemptId, campaign } = this.store.tx(() => {
      const reserved = this.mutate(
        scope,
        input.idempotencyKey,
        {
          kind: 'reserveFormalExecution',
          planId: plan.planId,
          planHash: sha256(canonicalJson(plan)),
          approvalId: input.approvalId,
          routeId: route.id,
          profileId: route.profileId,
          workspaceBindingHash: plan.workspaceBindingHash,
          connectionHash: route.connectionHash,
          remoteRoot: route.remoteRoot,
          authorityId: route.authorityId,
          admissionEvidenceHash: route.admissionEvidenceHash,
          reservedMaxCost: route.maxCost,
        },
        input.expectedVersion,
        false,
      )
      const dispatch = reserved.campaign.formalExecutionDispatches!.find(
        (item) => item.planId === plan.planId,
      )!
      const claimed = this.mutate(
        scope,
        `claim-formal:${dispatch.id}`,
        {
          kind: 'claimFormalExecution',
          dispatchId: dispatch.id,
        },
        reserved.campaign.version,
        false,
      )
      const attemptId = claimed.campaign.formalExecutionDispatches!.find(
        (item) => item.id === dispatch.id,
      )!.attemptId!
      const spec: FormalExecutionJobSpec = {
        version: 4,
        dispatchKey: attemptId,
        campaignId: scope.campaignId,
        taskRevisionId: plan.taskRevisionId,
        formalPlan: plan,
        formalPlanHash: sha256(canonicalJson(plan)),
        lease: {
          ownerId: `process-${process.pid}`,
          token: crypto.randomUUID(),
          fence: 1,
          expiresAt: Date.now() + 60_000,
        },
        execution: {
          adapter: 'formal-rootless-oci-v1',
          containerName: `formal_${sha256(attemptId).slice(7, 39)}`,
          authorityEpoch: identity.epoch,
        },
      }
      const authority: FormalExecutionAuthorityBinding = {
        schema: 'formal-execution-authority-binding-v1',
        routeId: route.id,
        profileId: route.profileId,
        workspaceBindingHash: plan.workspaceBindingHash,
        connectionHash: route.connectionHash,
        remoteRoot: route.remoteRoot,
        authorityId: route.authorityId,
        admissionEvidenceHash: route.admissionEvidenceHash,
        epoch: identity.epoch,
        jobSpecHash: sha256(canonicalJson(spec)),
        dispatchState: 'not_sent',
      }
      return {
        attemptId,
        campaign: this.mutate(
          scope,
          `bind-formal:${attemptId}`,
          {
            kind: 'bindFormalExecutionJob',
            dispatchId: dispatch.id,
            attemptId,
            spec,
            authority,
          },
          claimed.campaign.version,
          false,
        ).campaign,
      }
    })
    this.changed()
    void this.observe(scope, attemptId, route)
    return { campaign, attemptId, replayed: false }
  }
  async reconcile(scope: FormalExecutionScope, attemptId: string) {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    const binding = attempt?.formalExecutionAuthority
    if (!attempt || !binding || !attempt.formalExecutionJobSpec)
      throw new FormalExecutionControlError('正式执行缺少冻结作业规格；不会重投')
    const route = this.routes.find((item) => item.id === binding.routeId)
    if (!route) throw new FormalExecutionControlError('原正式执行路线不再准入；不会改投')
    void this.observe(scope, attemptId, route)
    return { campaign, attemptId }
  }
  recover(scope: FormalExecutionScope) {
    const campaign = this.campaign(scope)
    const attemptIds = campaign.attempts
      .filter(
        (item) => ['running', 'unknown'].includes(item.status) && item.formalExecutionAuthority,
      )
      .map((item) => item.id)
    for (const attemptId of attemptIds) void this.reconcile(scope, attemptId).catch(() => {})
    return { attemptIds }
  }
  async cancel(scope: FormalExecutionScope, attemptId: string) {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    if (!attempt?.formalExecutionAuthority)
      throw new FormalExecutionControlError('正式执行不存在', 404)
    if (!['running', 'unknown'].includes(attempt.status)) return { campaign }
    this.mutate(scope, `cancel-formal:${attemptId}`, { kind: 'requestCancelSynthetic', attemptId })
    return this.reconcile(scope, attemptId)
  }
  private async acquire(scope: FormalExecutionScope, attemptId: string, first: boolean) {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    const binding = attempt?.formalExecutionAuthority
    const spec = attempt?.formalExecutionJobSpec
    if (!attempt || !binding || !spec || !attempt.formalExecutionJobSpecHash) return null
    const result = this.mutate(
      scope,
      `${first ? 'dispatch' : 'observe'}-formal:${attemptId}:${this.instanceId}:${campaign.version}`,
      {
        kind: first ? 'claimFormalExecutionDispatch' : 'acquireFormalExecutionObservation',
        attemptId,
        instanceId: this.instanceId,
        expectedEpoch: binding.epoch,
        expectedJobSpecHash: attempt.formalExecutionJobSpecHash,
        leaseExpiresAt: Date.now() + OBSERVER_LEASE_MS,
      },
      campaign.version,
    )
    const updated = result.campaign.attempts.find((item) => item.id === attemptId)!
    const observer = updated.formalExecutionAuthority?.observer
    return observer ? { spec, epoch: binding.epoch, observer } : null
  }
  private async stageCandidate(
    route: FormalExecutionRoute,
    plan: FormalExecutionPlan,
    campaign: ResearchCampaign,
  ) {
    const staged = await this.candidates.read(plan, campaign)
    if (
      sha256(staged.code) !== plan.codeHash ||
      sha256(staged.candidateReceipt) !== plan.candidateReceiptHash
    )
      throw new FormalExecutionControlError('候选代码或收据字节不匹配冻结计划')
    await route.authority.registerCandidate({
      candidateArtifactId: plan.candidateArtifactId,
      code: staged.code,
      codeHash: plan.codeHash,
      candidateReceipt: staged.candidateReceipt,
      candidateReceiptHash: plan.candidateReceiptHash,
    })
  }
  private async observe(
    scope: FormalExecutionScope,
    attemptId: string,
    route: FormalExecutionRoute,
  ) {
    if (this.closed || this.observing.has(attemptId)) return
    this.observing.add(attemptId)
    try {
      const attempt = this.campaign(scope).attempts.find((item) => item.id === attemptId)
      const binding = attempt?.formalExecutionAuthority
      if (
        !attempt ||
        !binding ||
        !attempt.formalExecutionJobSpec ||
        !['running', 'unknown'].includes(attempt.status)
      )
        return
      const held = await this.acquire(scope, attemptId, binding.dispatchState === 'not_sent')
      if (!held) return
      await this.stageCandidate(route, held.spec.formalPlan, this.campaign(scope))
      const identity = await route.authority.identity()
      if (identity.epoch !== held.epoch) {
        this.mutate(scope, `unknown-formal:${attemptId}:${held.observer.generation}`, {
          kind: 'markFormalExecutionObservationUnknown',
          attemptId,
          instanceId: held.observer.instanceId,
          generation: held.observer.generation,
          expectedEpoch: held.epoch,
        })
        return
      }
      if (binding.dispatchState === 'not_sent') {
        try {
          await route.authority.submit(held.spec, held.epoch)
        } catch {
          /* query only; never replay */
        }
        this.mutate(scope, `ack-formal:${attemptId}:${held.observer.generation}`, {
          kind: 'acknowledgeFormalExecutionDispatch',
          attemptId,
          instanceId: held.observer.instanceId,
          generation: held.observer.generation,
          expectedEpoch: held.epoch,
        })
      }
      const job = await route.authority.query(attemptId, held.epoch)
      if (!job || job.status !== 'completed' || !job.contentHash) return
      const receipt = await route.authority.receipt(attemptId, held.epoch)
      if (
        sha256(receipt) !== job.contentHash ||
        !(await route.authority.verifyReceipt(held.spec, receipt))
      ) {
        this.mutate(scope, `unknown-receipt:${attemptId}:${held.observer.generation}`, {
          kind: 'markFormalExecutionObservationUnknown',
          attemptId,
          instanceId: held.observer.instanceId,
          generation: held.observer.generation,
          expectedEpoch: held.epoch,
        })
        return
      }
      this.mutate(scope, `finish-formal:${attemptId}:${held.observer.generation}`, {
        kind: 'finishFormalExecution',
        attemptId,
        observer: held.observer,
        uri: `formal://receipt/${attemptId}`,
        contentHash: sha256(receipt),
        receiptHash: sha256(receipt),
      })
    } finally {
      this.observing.delete(attemptId)
    }
  }
}
