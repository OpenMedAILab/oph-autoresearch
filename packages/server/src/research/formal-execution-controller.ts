import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const OBSERVER_LEASE_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 500
const MAX_RECEIPT_BYTES = 1024 * 1024

function canonicalRemoteRoot(value: string) {
  return (
    value.startsWith('/') &&
    value.length <= 4_096 &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!
      return code >= 0x20 && code !== 0x7f
    }) &&
    posix.normalize(value) === value
  )
}
function within(root: string, path: string) {
  return root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`)
}

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
      expectedEpoch: string
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
export interface FormalExecutionTrustedScope {
  profileId: string
  workspaceBindingHash: string
  connectionHash: string
  remoteRoot: string
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
    private readonly resolveScope: (
      scope: FormalExecutionScope,
    ) => Promise<FormalExecutionTrustedScope>,
    instanceId = `formal-observer-${crypto.randomUUID()}`,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
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
          !canonicalRemoteRoot(route.remoteRoot) ||
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
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000)
      throw new Error('Invalid formal execution poll interval')
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
  private routeFor(
    plan: FormalExecutionPlan,
    routeId: string,
    trusted: FormalExecutionTrustedScope,
  ) {
    const route = this.routes.find(
      (item) =>
        item.id === routeId &&
        item.profileId === trusted.profileId &&
        item.connectionHash === trusted.connectionHash &&
        item.remoteRoot === trusted.remoteRoot &&
        plan.workspaceBindingHash === trusted.workspaceBindingHash &&
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
    const route = this.routeFor(plan, input.routeId, await this.resolveScope(scope))
    const existing = before.formalExecutionDispatches?.find((item) => item.planId === plan.planId)
    if (existing) {
      if (
        existing.routeId !== route.id ||
        existing.profileId !== route.profileId ||
        existing.workspaceBindingHash !== plan.workspaceBindingHash ||
        existing.connectionHash !== route.connectionHash ||
        existing.remoteRoot !== route.remoteRoot ||
        existing.authorityId !== route.authorityId ||
        existing.admissionEvidenceHash !== route.admissionEvidenceHash ||
        !existing.attemptId
      )
        throw new FormalExecutionControlError('原正式执行绑定不可重放；不会改投或重建规格')
      this.startObservation(scope, existing.attemptId, route)
      return { campaign: before, attemptId: existing.attemptId, replayed: true }
    }
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
    this.startObservation(scope, attemptId, route)
    return { campaign, attemptId, replayed: false }
  }
  async reconcile(scope: FormalExecutionScope, attemptId: string) {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    const binding = attempt?.formalExecutionAuthority
    if (!attempt || !binding || !attempt.formalExecutionJobSpec)
      throw new FormalExecutionControlError('正式执行缺少冻结作业规格；不会重投')
    const route = this.routes.find((item) => item.id === binding.routeId)
    if (!route || !this.routeMatches(route, binding, await this.resolveScope(scope)))
      throw new FormalExecutionControlError('原正式执行路线不再准入；不会改投')
    this.startObservation(scope, attemptId, route)
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
    const changed = this.mutate(scope, `cancel-formal:${attemptId}`, {
      kind: 'requestCancelSynthetic',
      attemptId,
    }).campaign
    const binding = changed.attempts.find((item) => item.id === attemptId)?.formalExecutionAuthority
    const route = binding && this.routes.find((item) => item.id === binding.routeId)
    if (!binding || !route || !this.routeMatches(route, binding, await this.resolveScope(scope)))
      throw new FormalExecutionControlError('原正式执行路线不再准入；不会改投')
    const identity = await route.authority.identity()
    if (identity.schema !== 'research-authority-identity-v1' || identity.epoch !== binding.epoch)
      throw new FormalExecutionControlError('authority epoch 已变化；取消结果待保守观察')
    // This is a real authority cancellation.  A transport failure deliberately leaves the
    // durable attempt running/unknown for query-only recovery; it never causes a resubmit.
    await route.authority.cancel(attemptId, binding.epoch)
    this.startObservation(scope, attemptId, route)
    return { campaign: this.campaign(scope), attemptId }
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
    expectedEpoch: string,
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
      expectedEpoch,
    })
  }
  private startObservation(
    scope: FormalExecutionScope,
    attemptId: string,
    route: FormalExecutionRoute,
  ) {
    void this.observe(scope, attemptId, route).catch((error) => {
      // A failed observation must remain recoverable through the frozen attempt; never leave
      // an unhandled promise or turn an uncertain transport result into a new submission.
      console.error(`formal execution observation ${attemptId} failed`, error)
    })
  }
  private async fresh(
    scope: FormalExecutionScope,
    attemptId: string,
    route: FormalExecutionRoute,
    held: {
      epoch: string
      observer: { instanceId: string; generation: number; expiresAt: number }
    },
    allowCancelling = false,
  ) {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    const binding = attempt?.formalExecutionAuthority
    if (
      !attempt ||
      !binding ||
      !attempt.formalExecutionJobSpec ||
      binding.epoch !== held.epoch ||
      binding.observer?.instanceId !== held.observer.instanceId ||
      binding.observer.generation !== held.observer.generation ||
      binding.observer.expiresAt <= Date.now() ||
      (!allowCancelling && attempt.cancelRequestedAt !== null) ||
      !['running', 'unknown'].includes(attempt.status) ||
      !this.routeMatches(route, binding, await this.resolveScope(scope))
    )
      return null
    return { campaign, attempt, binding, spec: attempt.formalExecutionJobSpec }
  }
  private async receiptFile(
    scope: FormalExecutionScope,
    attemptId: string,
    receipt: Uint8Array,
  ): Promise<{ uri: string; hash: string }> {
    if (receipt.byteLength > MAX_RECEIPT_BYTES)
      throw new FormalExecutionControlError('正式执行回执超过 1 MiB 上限')
    const root = resolve(scope.workspaceRoot)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new FormalExecutionControlError('工作区根目录不安全')
    const rootRealpath = await realpath(root)
    let directory = rootRealpath
    for (const segment of ['.oph', 'research', scope.campaignId, attemptId]) {
      const next = join(directory, segment)
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (error: unknown) {
        if (!(error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST'))
          throw error
      }
      const stat = await lstat(next)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !within(rootRealpath, await realpath(next))
      )
        throw new FormalExecutionControlError('正式执行回执目录不安全')
      directory = next
    }
    const file = join(directory, 'formal-receipt.json')
    const hash = sha256(receipt)
    try {
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0)
          throw new FormalExecutionControlError('正式执行回执文件不安全')
        await handle.writeFile(receipt)
        if ((await handle.stat()).size !== receipt.byteLength)
          throw new FormalExecutionControlError('正式执行回执写入不完整')
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST'))
        throw error
      // A retry may reuse only the exact immutable receipt; a different byte sequence is
      // quarantined by refusing to overwrite it.
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      let existing: Uint8Array
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RECEIPT_BYTES)
          throw new FormalExecutionControlError('已有正式执行回执文件不安全')
        existing = new Uint8Array(stat.size)
        let offset = 0
        while (offset < existing.byteLength) {
          const { bytesRead } = await handle.read(
            existing,
            offset,
            existing.byteLength - offset,
            offset,
          )
          if (bytesRead === 0) throw new FormalExecutionControlError('已有正式执行回执在读取时变化')
          offset += bytesRead
        }
        if ((await handle.stat()).size !== existing.byteLength)
          throw new FormalExecutionControlError('已有正式执行回执在读取时变化')
      } finally {
        await handle.close()
      }
      if (sha256(existing!) !== hash)
        throw new FormalExecutionControlError('已有回执与 authority 回执哈希不一致')
    }
    return { uri: pathToFileURL(file).toString(), hash }
  }
  private async markUnknown(
    scope: FormalExecutionScope,
    attemptId: string,
    held: { epoch: string; observer: { instanceId: string; generation: number } },
  ) {
    try {
      this.mutate(scope, `unknown-formal:${attemptId}:${held.observer.generation}`, {
        kind: 'markFormalExecutionObservationUnknown',
        attemptId,
        instanceId: held.observer.instanceId,
        generation: held.observer.generation,
        expectedEpoch: held.epoch,
      })
    } catch {
      // A newer observer or terminal event owns the state.  It is safer to do nothing.
    }
  }
  private async observe(
    scope: FormalExecutionScope,
    attemptId: string,
    route: FormalExecutionRoute,
  ) {
    if (this.closed || this.observing.has(attemptId)) return
    this.observing.add(attemptId)
    let resume = false
    try {
      let deadline = Date.now() + 30_000
      while (!this.closed && Date.now() < deadline) {
        const initial = this.campaign(scope).attempts.find((item) => item.id === attemptId)
        const binding = initial?.formalExecutionAuthority
        if (
          !initial ||
          !binding ||
          !initial.formalExecutionJobSpec ||
          !['running', 'unknown'].includes(initial.status)
        )
          return
        deadline = Math.max(
          deadline,
          initial.executionStartedAt +
            initial.formalExecutionJobSpec.formalPlan.resources.maxRuntimeMs +
            30_000,
        )
        if (!this.routeMatches(route, binding, await this.resolveScope(scope))) return
        const first = binding.dispatchState === 'not_sent'
        const held = await this.acquire(scope, attemptId, first)
        if (!held) return
        try {
          const identity = await route.authority.identity()
          if (
            identity.schema !== 'research-authority-identity-v1' ||
            identity.epoch !== held.epoch
          ) {
            await this.markUnknown(scope, attemptId, held)
            return
          }
          if (first) {
            const beforeDispatch = await this.fresh(scope, attemptId, route, held, true)
            if (!beforeDispatch) return
            if (beforeDispatch.attempt.cancelRequestedAt !== null) {
              // A persisted cancellation can survive a process restart before the first send.
              // It is never allowed to stage or submit a new job.
              await route.authority.cancel(attemptId, held.epoch)
            } else {
              const beforeStage = await this.fresh(scope, attemptId, route, held)
              if (!beforeStage) return
              await this.stageCandidate(
                route,
                held.spec.formalPlan,
                beforeStage.campaign,
                held.epoch,
              )
              if (!(await this.fresh(scope, attemptId, route, held))) return
              try {
                await route.authority.submit(held.spec, held.epoch)
              } catch {
                // Lost response is deliberately resolved by query below with this same dispatch key.
              }
              if (!(await this.fresh(scope, attemptId, route, held))) return
              this.mutate(scope, `ack-formal:${attemptId}:${held.observer.generation}`, {
                kind: 'acknowledgeFormalExecutionDispatch',
                attemptId,
                instanceId: held.observer.instanceId,
                generation: held.observer.generation,
                expectedEpoch: held.epoch,
              })
            }
          }
          const beforeQuery = await this.fresh(scope, attemptId, route, held, true)
          if (!beforeQuery) return
          if (beforeQuery.attempt.cancelRequestedAt !== null) {
            // Repeat the idempotent authority cancellation on every recovery pass. A restarted
            // controller must not merely observe a still-running container forever.
            await route.authority.cancel(attemptId, held.epoch)
          }
          const job = await route.authority.query(attemptId, held.epoch)
          const current = await this.fresh(scope, attemptId, route, held, true)
          if (!current) return
          if (
            job &&
            (job.specHash !== sha256(canonicalJson(held.spec)) ||
              canonicalJson(job.spec) !== canonicalJson(held.spec))
          ) {
            await this.markUnknown(scope, attemptId, held)
            resume = true
            await Bun.sleep(this.pollIntervalMs)
            continue
          }
          if (
            !job ||
            ['queued', 'running', 'cancel_requested', 'completion_requested'].includes(job.status)
          ) {
            resume = true
            await Bun.sleep(this.pollIntervalMs)
            continue
          }
          if (['cancelled', 'failed', 'interrupted'].includes(job.status)) {
            this.mutate(scope, `close-formal:${attemptId}:${held.observer.generation}`, {
              kind: 'closeFormalExecution',
              attemptId,
              observer: held.observer,
              status: job.status as 'cancelled' | 'failed' | 'interrupted',
              error: job.error ?? `authority reported ${job.status}`,
            })
            resume = false
            return
          }
          if (job.status === 'completed' && current.attempt.cancelRequestedAt !== null) {
            this.mutate(scope, `late-cancelled-formal:${attemptId}:${held.observer.generation}`, {
              kind: 'closeFormalExecution',
              attemptId,
              observer: held.observer,
              status: 'cancelled',
              error: 'Authority completed after cancellation; result quarantined',
              lateCompleted: true,
            })
            resume = false
            return
          }
          if (job.status !== 'completed' || !job.contentHash) {
            await this.markUnknown(scope, attemptId, held)
            return
          }
          const receipt = await route.authority.receipt(attemptId, held.epoch)
          if (!(await this.fresh(scope, attemptId, route, held))) {
            if (
              this.campaign(scope).attempts.find((item) => item.id === attemptId)
                ?.cancelRequestedAt !== null
            ) {
              resume = true
              await Bun.sleep(this.pollIntervalMs)
              continue
            }
            return
          }
          const verified = await route.authority.verifyReceipt(held.spec, receipt)
          // Receipt I/O and verification can be slow. Reacquire current state before it is
          // admitted so cancellation, revocation, route drift, or a newer observer wins.
          if (!(await this.fresh(scope, attemptId, route, held))) {
            if (
              this.campaign(scope).attempts.find((item) => item.id === attemptId)
                ?.cancelRequestedAt !== null
            ) {
              resume = true
              await Bun.sleep(this.pollIntervalMs)
              continue
            }
            return
          }
          if (sha256(receipt) !== job.contentHash || !verified) {
            await this.markUnknown(scope, attemptId, held)
            return
          }
          const saved = await this.receiptFile(scope, attemptId, receipt)
          if (!(await this.fresh(scope, attemptId, route, held))) {
            if (
              this.campaign(scope).attempts.find((item) => item.id === attemptId)
                ?.cancelRequestedAt !== null
            ) {
              resume = true
              await Bun.sleep(this.pollIntervalMs)
              continue
            }
            return
          }
          const task = current.campaign.taskRevisions.find(
            (item) => item.id === current.attempt.taskRevisionId,
          )
          if (!task || !current.attempt.formalExecutionJobSpecHash) {
            await this.markUnknown(scope, attemptId, held)
            return
          }
          this.mutate(scope, `finish-formal:${attemptId}:${held.observer.generation}`, {
            kind: 'finishFormalExecution',
            attemptId,
            observer: held.observer,
            uri: saved.uri,
            contentHash: saved.hash,
            receiptHash: saved.hash,
            validation: {
              schema: 'research-formal-oci-completion-v1',
              jobSpecHash: current.attempt.formalExecutionJobSpecHash,
              formalPlanHash: held.spec.formalPlanHash,
              inputHash: task.inputHash,
              contentHash: saved.hash,
              byteLength: receipt.byteLength,
              evaluatorHash: held.spec.formalPlan.trustedEvaluatorHash,
              validatedAt: Date.now(),
            },
          })
          resume = false
          return
        } catch {
          await this.markUnknown(scope, attemptId, held)
          // A transient transport error is not a terminal fact. Continue query-only recovery
          // with the same frozen key and never reconstruct the submission.
          resume = true
          await Bun.sleep(this.pollIntervalMs)
        }
      }
    } finally {
      this.observing.delete(attemptId)
      if (resume && !this.closed) {
        const attempt = this.campaign(scope).attempts.find((item) => item.id === attemptId)
        if (attempt && ['running', 'unknown'].includes(attempt.status))
          setTimeout(() => this.startObservation(scope, attemptId, route), this.pollIntervalMs)
      }
    }
  }
  private routeMatches(
    route: FormalExecutionRoute,
    binding: FormalExecutionAuthorityBinding,
    trusted: FormalExecutionTrustedScope,
  ) {
    return (
      route.id === binding.routeId &&
      route.profileId === binding.profileId &&
      (route.workspaceBindingHash === undefined ||
        route.workspaceBindingHash === binding.workspaceBindingHash) &&
      route.connectionHash === binding.connectionHash &&
      route.remoteRoot === binding.remoteRoot &&
      route.authorityId === binding.authorityId &&
      route.admissionEvidenceHash === binding.admissionEvidenceHash &&
      trusted.profileId === binding.profileId &&
      trusted.workspaceBindingHash === binding.workspaceBindingHash &&
      trusted.connectionHash === binding.connectionHash &&
      trusted.remoteRoot === binding.remoteRoot
    )
  }
}
