import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type CliPreparationFrozenConfig,
  type CliPreparationJobSpec,
  type CliPreparationObserverIdentity,
  type CliPreparationObserverLease,
  canonicalCliPreparationConfig,
  type ResearchCampaign,
  type ResearchCommand,
} from '@oph-autoresearch/core'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { verifyCandidateReceipt } from './cli-preparation-candidate.ts'
import type { DurableJob } from './job-daemon.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

/** All executable details remain in the remote administrator's admitted configuration. */
export interface CliPreparationRoute {
  id: string
  label: string
  deviceId: string
  adapterId: string
  model: string
  adapterConfigHash: string
  authority: {
    readonly backendPolicyHash: string
    identity():
      | { schema: 'research-authority-identity-v1'; epoch: string }
      | Promise<{ schema: 'research-authority-identity-v1'; epoch: string }>
    closeUnstarted(request: {
      expectedEpoch: string
      dispatchKey: string
      specHash: string
    }): Promise<{ outcome: string }> | { outcome: string }
    submit(spec: CliPreparationJobSpec): DurableJob | Promise<DurableJob>
    query(key: string): DurableJob | null | Promise<DurableJob | null>
    cancel(key: string): DurableJob | null | Promise<DurableJob | null>
    receipt(key: string): Uint8Array | Promise<Uint8Array>
  }
}
export class CliPreparationControlError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}
export interface CliPreparationScope {
  workspaceId: string
  workspaceRoot: string
  campaignId: string
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HASH = /^sha256:[a-f0-9]{64}$/
const EPOCH = /^[A-Za-z0-9_-]{16,128}$/
const OBSERVER_LEASE_MS = 30_000

/** Durable claim precedes transport. Recovery only observes the original immutable remote key. */
export class CliPreparationController {
  private readonly routes: readonly CliPreparationRoute[]
  private readonly observing = new Set<string>()
  private closed = false
  private readonly instanceId: string
  constructor(
    private readonly store: Store,
    routes: readonly CliPreparationRoute[],
    private readonly changed: () => void,
    private readonly beforeBind?: () => void,
    instanceId = `cli-observer-${crypto.randomUUID()}`,
  ) {
    if (
      new Set(routes.map((route) => route.id)).size !== routes.length ||
      routes.some(
        (route) =>
          !ID.test(route.id) ||
          !ID.test(route.deviceId) ||
          !ID.test(route.adapterId) ||
          !route.label.trim() ||
          !route.model ||
          !HASH.test(route.adapterConfigHash) ||
          !HASH.test(route.authority.backendPolicyHash),
      )
    )
      throw new Error('Invalid admitted CLI preparation catalog')
    if (!ID.test(instanceId)) throw new Error('Invalid CLI preparation observer instance')
    this.instanceId = instanceId
    this.routes = routes.map((route) => Object.freeze({ ...route }))
  }
  close() {
    this.closed = true
  }
  catalog() {
    return this.routes.map(({ id, label, model }) => ({ id, label, model }))
  }
  private campaign(scope: CliPreparationScope) {
    const campaign = getResearchCampaign(this.store, scope.campaignId)
    if (!campaign || campaign.workspaceId !== scope.workspaceId)
      throw new CliPreparationControlError('研究项目不存在', 404)
    return campaign
  }
  private mutate(
    scope: CliPreparationScope,
    key: string,
    command: ResearchCommand,
    version = this.campaign(scope).version,
    notify = true,
  ) {
    const result = mutateResearchCampaign(this.store, scope.campaignId, {
      expectedVersion: version,
      idempotencyKey: key,
      command,
    })
    if (!result.ok) throw new CliPreparationControlError(result.message)
    if (notify) this.notifyAfterCommit()
    return result
  }
  private notifyAfterCommit() {
    try {
      this.changed()
    } catch (error) {
      // The ledger is already committed. Preserve that result and leave a visible diagnostic.
      console.error('CLI preparation change notification failed after commit', error)
    }
  }
  propose(
    scope: CliPreparationScope,
    input: {
      expectedVersion: number
      idempotencyKey: string
      routeId: string
      taskRevisionId: string
      instructions: string
      maxRuntimeMs: number
      maxCost: number
      acknowledgeUnknownCost: true
    },
  ) {
    const campaign = this.campaign(scope)
    const route = this.routes.find((item) => item.id === input.routeId)
    const task = campaign.taskRevisions.find((item) => item.id === input.taskRevisionId)
    if (!route || !task || input.acknowledgeUnknownCost !== true || !ID.test(input.idempotencyKey))
      throw new CliPreparationControlError('请选择已准入的远端工具与当前任务，并确认未知费用', 400)
    const identity = sha256(
      canonicalJson({ campaignId: campaign.id, key: input.idempotencyKey }),
    ).slice(7, 39)
    const frozen: CliPreparationFrozenConfig = {
      preparationId: `rcp_${identity}`,
      candidateId: `candidate_${identity}`,
      dispatchKey: `prepare_${identity}`,
      taskRevisionId: task.id,
      adapterId: route.adapterId,
      adapterConfigHash: route.adapterConfigHash,
      backendPolicyHash: route.authority.backendPolicyHash,
      model: route.model,
      instructions: input.instructions,
      inputHash: task.inputHash,
      deviceId: route.deviceId,
      maxRuntimeMs: input.maxRuntimeMs,
      maxCost: input.maxCost,
      acknowledgeUnknownCost: true,
    }
    const result = this.mutate(
      scope,
      input.idempotencyKey,
      {
        kind: 'proposeCliPreparation',
        ...frozen,
        configHash: sha256(canonicalCliPreparationConfig(frozen)),
      },
      input.expectedVersion,
    )
    return { ...result, preparationId: frozen.preparationId }
  }
  approval(scope: CliPreparationScope, preparationId: string) {
    const campaign = this.campaign(scope)
    const preparation = campaign.cliPreparations?.find((item) => item.id === preparationId)
    const task = campaign.taskRevisions.find((item) => item.id === preparation?.taskRevisionId)
    if (!preparation || !task || preparation.status !== 'proposed')
      throw new CliPreparationControlError('没有待批准的准备任务')
    return {
      expectedVersion: campaign.version,
      idempotencyKey: `approve-${crypto.randomUUID()}`,
      bundleHash: campaign.bundleHash,
      scope: {
        kind: 'cli_preparation' as const,
        taskRevisionId: task.id,
        dispatchKey: preparation.dispatchKey,
        artifactVersionIds: [],
        display: { title: campaign.goal, task: task.templateId, revision: task.revision },
        backendPolicyHash: preparation.backendPolicyHash,
        configHash: preparation.configHash,
        currency: campaign.budget.currency,
        maxCost: preparation.maxCost,
        expiresAt: Date.now() + 15 * 60_000,
        preparationLimits: {
          maxRuntimeMs: preparation.maxRuntimeMs,
          cpu: 1 as const,
          memoryMb: 256 as const,
          adapterConfigHash: preparation.adapterConfigHash,
          acknowledgeUnknownCost: true as const,
        },
      },
    }
  }
  async submit(
    scope: CliPreparationScope,
    input: { preparationId: string; approvalId: string; expectedVersion: number },
  ) {
    const before = this.campaign(scope)
    const preparation = before.cliPreparations?.find((item) => item.id === input.preparationId)
    if (!preparation) throw new CliPreparationControlError('准备任务不存在', 404)
    if (preparation.attemptId)
      return { campaign: before, attemptId: preparation.attemptId, replayed: true }
    const route = this.routeFor(preparation)
    const identity = await route.authority.identity()
    if (identity.schema !== 'research-authority-identity-v1' || !EPOCH.test(identity.epoch))
      throw new CliPreparationControlError('远端执行 authority 身份无效；不会投递准备任务')
    const { bound, attemptId } = this.store.tx(() => {
      const claimed = this.mutate(
        scope,
        `claim-cli:${preparation.id}`,
        {
          kind: 'claimCliPreparation',
          preparationId: preparation.id,
          approvalId: input.approvalId,
        },
        input.expectedVersion,
        false,
      )
      const attemptId = claimed.campaign.cliPreparations!.find(
        (item) => item.id === preparation.id,
      )!.attemptId!
      const task = claimed.campaign.taskRevisions.find(
        (item) => item.id === preparation.taskRevisionId,
      )!
      const spec: CliPreparationJobSpec = {
        version: 3,
        dispatchKey: attemptId,
        campaignId: scope.campaignId,
        taskRevisionId: task.id,
        templateId: task.templateId,
        inputHash: preparation.inputHash,
        backendPolicyHash: preparation.backendPolicyHash,
        resource: { cpu: 1, memoryMb: 256 },
        lease: {
          ownerId: `process-${process.pid}`,
          token: crypto.randomUUID(),
          fence: 1,
          expiresAt: Date.now() + 60_000,
        },
        execution: {
          adapter: 'cli-preparation-v1',
          preparationId: preparation.id,
          candidateId: preparation.candidateId,
          clientDispatchKey: preparation.dispatchKey,
          adapterId: preparation.adapterId,
          adapterConfigHash: preparation.adapterConfigHash,
          model: preparation.model,
          instructions: preparation.instructions,
          configHash: preparation.configHash,
          deviceId: preparation.deviceId,
          maxRuntimeMs: preparation.maxRuntimeMs,
          maxCost: preparation.maxCost,
        },
      }
      this.beforeBind?.()
      const bound = this.mutate(
        scope,
        `bind-cli:${attemptId}`,
        { kind: 'bindCliPreparationJob', attemptId, spec, authorityEpoch: identity.epoch },
        undefined,
        false,
      )
      return { bound, attemptId }
    })
    this.notifyAfterCommit()
    void this.observe(scope, attemptId, route).catch(() =>
      console.error('CLI preparation observation could not persist'),
    )
    return { campaign: bound.campaign, attemptId, replayed: false }
  }
  private routeFor(preparation: NonNullable<ResearchCampaign['cliPreparations']>[number]) {
    const route = this.routes.find(
      (item) =>
        item.deviceId === preparation.deviceId &&
        item.adapterId === preparation.adapterId &&
        item.model === preparation.model &&
        item.adapterConfigHash === preparation.adapterConfigHash &&
        item.authority.backendPolicyHash === preparation.backendPolicyHash,
    )
    if (!route)
      throw new CliPreparationControlError(
        '原执行设备或工具准入已变化，请重新核对；不会改投其他服务器',
      )
    return route
  }
  async reconcile(scope: CliPreparationScope, attemptId: string) {
    const campaign = this.campaign(scope)
    const preparation = campaign.cliPreparations?.find((item) => item.attemptId === attemptId)
    if (!preparation) throw new CliPreparationControlError('准备运行不存在', 404)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    if (!attempt?.cliPreparationJobSpec) {
      if (attempt?.status === 'running')
        this.mutate(scope, `unknown-unbound-cli:${attemptId}`, {
          kind: 'markSyntheticUnknown',
          attemptId,
          reason: '旧准备尝试缺少冻结作业规格，必须人工核对；不会重新批准或投递',
        })
      return { campaign: this.campaign(scope), attemptId }
    }
    void this.observe(scope, attemptId, this.routeFor(preparation)).catch(() =>
      console.error('CLI preparation recovery observation could not persist'),
    )
    return { campaign: this.campaign(scope), attemptId }
  }
  /** Startup hook: resume only already-bound durable remote jobs; never submit a replacement. */
  recover(scope: CliPreparationScope) {
    const campaign = this.campaign(scope)
    const attemptIds = campaign.attempts
      .filter(
        (attempt) =>
          (attempt.status === 'running' || attempt.status === 'unknown') &&
          (campaign.cliPreparations ?? []).some(
            (preparation) => preparation.attemptId === attempt.id,
          ),
      )
      .map((attempt) => attempt.id)
    for (const attemptId of attemptIds) {
      void this.reconcile(scope, attemptId).catch((error) => {
        const reason = error instanceof Error ? error.message : 'unknown recovery error'
        console.error(`CLI preparation ${attemptId} requires manual verification: ${reason}`)
      })
    }
    return { attemptIds }
  }
  async cancel(scope: CliPreparationScope, attemptId: string) {
    const campaign = this.campaign(scope)
    const preparation = campaign.cliPreparations?.find((item) => item.attemptId === attemptId)
    if (!preparation) throw new CliPreparationControlError('准备运行不存在', 404)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)!
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(attempt.status))
      return { campaign }
    this.mutate(scope, `cancel-cli:${attemptId}`, { kind: 'requestCancelSynthetic', attemptId })
    return this.reconcile(scope, attemptId)
  }

  private jobHash(spec: CliPreparationJobSpec) {
    return sha256(canonicalJson(spec))
  }
  private async hasExpectedEpoch(route: CliPreparationRoute, epoch: string) {
    const identity = await route.authority.identity()
    return identity.schema === 'research-authority-identity-v1' && identity.epoch === epoch
  }
  private async acquireObserver(
    scope: CliPreparationScope,
    attemptId: string,
    mode: 'first_send' | 'observe',
  ): Promise<{
    epoch: string
    observer: CliPreparationObserverLease
    spec: CliPreparationJobSpec
  } | null> {
    const campaign = this.campaign(scope)
    const attempt = campaign.attempts.find((item) => item.id === attemptId)
    const spec = attempt?.cliPreparationJobSpec
    const binding = attempt?.cliPreparationAuthority
    if (!attempt || !spec || !binding || !attempt.cliPreparationJobSpecHash) return null
    const expectedJobSpecHash = attempt.cliPreparationJobSpecHash
    const command = {
      attemptId,
      instanceId: this.instanceId,
      expectedEpoch: binding.epoch,
      expectedJobSpecHash,
      leaseExpiresAt: Date.now() + OBSERVER_LEASE_MS,
    }
    const result = this.mutate(
      scope,
      `${mode === 'first_send' ? 'dispatch' : 'observe'}-cli:${attemptId}:${this.instanceId}:${campaign.version}`,
      {
        kind:
          mode === 'first_send'
            ? 'claimCliPreparationDispatch'
            : 'acquireCliPreparationObservation',
        ...command,
      },
      campaign.version,
    )
    let updated = result.campaign.attempts.find((item) => item.id === attemptId)
    const observer = updated?.cliPreparationAuthority?.observer
    if (
      !updated?.cliPreparationAuthority ||
      updated.cliPreparationAuthority.epoch !== binding.epoch ||
      updated.cliPreparationAuthority.jobSpecHash !== expectedJobSpecHash ||
      !observer ||
      observer.instanceId !== this.instanceId
    )
      return null
    if (updated.status === 'unknown') {
      const resumed = this.mutate(
        scope,
        `resume-cli:${attemptId}:${observer.generation}:${result.campaign.version}`,
        {
          kind: 'resumeSyntheticObservation',
          attemptId,
          jobSpecHash: expectedJobSpecHash,
          observer,
        },
        result.campaign.version,
      )
      updated = resumed.campaign.attempts.find((item) => item.id === attemptId)
      if (!updated) return null
    }
    return { epoch: binding.epoch, observer, spec }
  }
  private markObservationUnknown(
    scope: CliPreparationScope,
    attemptId: string,
    epoch: string,
    observer: CliPreparationObserverIdentity,
    reason: string,
  ) {
    const campaign = this.campaign(scope)
    this.mutate(
      scope,
      `authority-observation-unknown:${attemptId}:${observer.generation}`,
      {
        kind: 'markCliPreparationObservationUnknown',
        attemptId,
        instanceId: observer.instanceId,
        generation: observer.generation,
        expectedEpoch: epoch,
      },
      campaign.version,
    )
    const current = this.campaign(scope)
    const attempt = current.attempts.find((item) => item.id === attemptId)
    if (attempt?.status === 'running' || attempt?.status === 'unknown')
      this.mutate(
        scope,
        `unknown-cli:${attemptId}:${observer.generation}`,
        { kind: 'markSyntheticUnknown', attemptId, reason, observer },
        current.version,
      )
  }
  private async observe(scope: CliPreparationScope, attemptId: string, route: CliPreparationRoute) {
    if (this.observing.has(attemptId)) return
    this.observing.add(attemptId)
    let held:
      | { epoch: string; observer: CliPreparationObserverLease; spec: CliPreparationJobSpec }
      | undefined
    try {
      let campaign = this.campaign(scope)
      let attempt = campaign.attempts.find((item) => item.id === attemptId)!
      const spec = attempt.cliPreparationJobSpec
      const binding = attempt.cliPreparationAuthority
      if (
        !spec ||
        !attempt.cliPreparationJobSpecHash ||
        !binding ||
        ['completed', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)
      )
        return
      held = await this.acquireObserver(
        scope,
        attemptId,
        binding.dispatchState === 'not_sent' ? 'first_send' : 'observe',
      )
      if (!held) return
      if (!(await this.hasExpectedEpoch(route, held.epoch))) {
        this.markObservationUnknown(
          scope,
          attemptId,
          held.epoch,
          held.observer,
          '远端 authority epoch 已变化；不能把新实例的空结果当作原作业未开始',
        )
        return
      }
      if (binding.dispatchState === 'not_sent') {
        // `sending` is durable before this request. A lost response is observed below,
        // never retried as a second submit.
        try {
          await route.authority.submit(held.spec)
          const current = this.campaign(scope)
          this.mutate(
            scope,
            `acknowledge-cli:${attemptId}:${held.observer.generation}`,
            {
              kind: 'acknowledgeCliPreparationDispatch',
              attemptId,
              instanceId: held.observer.instanceId,
              generation: held.observer.generation,
              expectedEpoch: held.epoch,
            },
            current.version,
          )
        } catch {
          // Query the exact immutable key below. The sending CAS prohibits resubmission.
        }
      }
      const deadline = Date.now() + spec.execution.maxRuntimeMs + 30_000
      do {
        if (this.closed) return
        if (held.observer.generation > 0 && held.observer.expiresAt <= Date.now() + 10_000) {
          held = (await this.acquireObserver(scope, attemptId, 'observe')) ?? undefined
          if (!held) return
        }
        if (!(await this.hasExpectedEpoch(route, held.epoch))) {
          this.markObservationUnknown(
            scope,
            attemptId,
            held.epoch,
            held.observer,
            '远端 authority epoch 已变化；不能接受该实例之前读取的执行状态或回执',
          )
          return
        }
        const job = await route.authority.query(attemptId)
        if (!job) {
          const current = this.campaign(scope)
          const currentBinding = current.attempts.find(
            (item) => item.id === attemptId,
          )?.cliPreparationAuthority
          if (currentBinding?.dispatchState === 'sending') {
            const proof = await route.authority.closeUnstarted({
              expectedEpoch: held.epoch,
              dispatchKey: attemptId,
              specHash: this.jobHash(held.spec),
            })
            if (proof.outcome === 'not_started') {
              const latest = this.campaign(scope)
              this.mutate(
                scope,
                `not-started-cli:${attemptId}:${held.observer.generation}`,
                {
                  kind: 'interruptSynthetic',
                  attemptId,
                  reason: '远端 authority 已在相同 epoch 下持久确认该作业未开始',
                  observer: held.observer,
                },
                latest.version,
              )
              return
            }
          }
          throw new Error('Original remote job has no durable authority observation')
        }
        if (job.specHash !== this.jobHash(held.spec))
          throw new Error('Original remote job has changed')
        campaign = this.campaign(scope)
        attempt = campaign.attempts.find((item) => item.id === attemptId)!
        if (attempt.cliPreparationAuthority?.dispatchState === 'sending') {
          this.mutate(
            scope,
            `acknowledge-cli-observed:${attemptId}:${held.observer.generation}`,
            {
              kind: 'acknowledgeCliPreparationDispatch',
              attemptId,
              instanceId: held.observer.instanceId,
              generation: held.observer.generation,
              expectedEpoch: held.epoch,
            },
            campaign.version,
          )
          campaign = this.campaign(scope)
          attempt = campaign.attempts.find((item) => item.id === attemptId)!
        }
        if (attempt.cancelRequestedAt !== null && job.status !== 'cancelled')
          await route.authority.cancel(attemptId)
        if (job.status === 'completed') {
          const bytes = await route.authority.receipt(attemptId)
          if (!(await this.hasExpectedEpoch(route, held.epoch))) {
            this.markObservationUnknown(
              scope,
              attemptId,
              held.epoch,
              held.observer,
              '读取回执期间 authority epoch 已变化；回执不能被接纳',
            )
            return
          }
          if (bytes.byteLength > 1_000_000) throw new Error('Candidate receipt exceeds limit')
          const receipt: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
          if (!verifyCandidateReceipt(receipt, spec))
            throw new Error('Candidate receipt verification failed')
          const { draft, ...binding } = receipt
          const uri = await persistCandidate(
            scope.workspaceRoot,
            scope.campaignId,
            attemptId,
            bytes,
          )
          const validation = {
            ...binding,
            contentHash: sha256(bytes),
            draftContentHash: draft.contentHash,
            byteLength: bytes.byteLength,
            verifiedAt: Date.now(),
          }
          held = (await this.acquireObserver(scope, attemptId, 'observe')) ?? undefined
          if (!held) return
          const terminalObserver = held.observer
          // Receipt retrieval and persistence may take long enough for a local
          // cancellation or approval revocation to commit. Re-read and classify
          // the result in the same SQLite transaction as the terminal command.
          // The finish reducer retains the same revoked/cancelled guard as a
          // defense in depth for callers outside this controller.
          this.store.tx(() => {
            const current = this.campaign(scope)
            const currentAttempt = current.attempts.find((item) => item.id === attemptId)
            if (!currentAttempt) throw new CliPreparationControlError('准备执行记录不存在', 404)
            const consumedApproval = current.approvals.find((item) => item.consumedBy === attemptId)
            const quarantine =
              currentAttempt.cancelRequestedAt !== null || consumedApproval?.status === 'revoked'
            this.mutate(
              scope,
              `${quarantine ? 'quarantine' : 'finish'}-cli:${attemptId}`,
              quarantine
                ? {
                    kind: 'quarantineCliPreparationResult',
                    attemptId,
                    uri,
                    contentHash: sha256(bytes),
                    validation,
                    observer: terminalObserver,
                  }
                : {
                    kind: 'finishCliPreparation',
                    attemptId,
                    uri,
                    artifactKind: 'cli_preparation_candidate',
                    contentHash: sha256(bytes),
                    validation,
                    observer: terminalObserver,
                  },
              current.version,
              false,
            )
          })
          this.notifyAfterCommit()
          return
        }
        if (job.status === 'cancelled') {
          this.mutate(scope, `cancelled-cli:${attemptId}`, {
            kind: 'interruptSynthetic',
            attemptId,
            reason: '远端执行者已确认准备进程停止',
            observer: held.observer,
          })
          return
        }
        if (job.status === 'interrupted') {
          this.mutate(scope, `interrupted-cli:${attemptId}`, {
            kind: 'interruptSynthetic',
            attemptId,
            reason: '远端准备进程已中断，费用仍待核对',
            observer: held.observer,
          })
          return
        }
        if (job.status === 'failed') {
          this.mutate(scope, `failed-cli:${attemptId}`, {
            kind: 'failSynthetic',
            attemptId,
            error: '远端代码准备未完成，费用仍待核对',
            observer: held.observer,
          })
          return
        }
        await Bun.sleep(250)
      } while (Date.now() < deadline)
      throw new Error('Observation time limit reached')
    } catch {
      if (held)
        try {
          this.markObservationUnknown(
            scope,
            attemptId,
            held.epoch,
            held.observer,
            '准备状态待核对；保留原运行与费用预留，不自动重投',
          )
        } catch {
          // A newer observer owns the result. It will continue from durable state.
        }
    } finally {
      this.observing.delete(attemptId)
    }
  }
}
async function persistCandidate(
  root: string,
  campaignId: string,
  attemptId: string,
  bytes: Uint8Array,
) {
  if (!ID.test(campaignId) || !ID.test(attemptId)) throw new Error('Invalid candidate path')
  let directory = await realpath(root)
  for (const segment of ['.oph', 'research', campaignId, attemptId]) {
    directory = join(directory, segment)
    await mkdir(directory).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe candidate directory')
  }
  const path = join(directory, 'cli-candidate.json')
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(path)) !== sha256(bytes))
      throw new Error('Candidate file already differs')
  }
  return pathToFileURL(path).href
}
