import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type CliPreparationFrozenConfig,
  type CliPreparationJobSpec,
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

/** Durable claim precedes transport. Recovery only observes the original immutable remote key. */
export class CliPreparationController {
  private readonly routes: readonly CliPreparationRoute[]
  private readonly observing = new Set<string>()
  private closed = false
  constructor(
    private readonly store: Store,
    routes: readonly CliPreparationRoute[],
    private readonly changed: () => void,
    private readonly beforeBind?: () => void,
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
        { kind: 'bindCliPreparationJob', attemptId, spec },
        undefined,
        false,
      )
      return { bound, attemptId }
    })
    this.notifyAfterCommit()
    void this.observe(scope, attemptId, route, true).catch(() =>
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
    void this.observe(scope, attemptId, this.routeFor(preparation), false).catch(() =>
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
    await this.routeFor(preparation).authority.cancel(attemptId)
    return this.reconcile(scope, attemptId)
  }
  private async observe(
    scope: CliPreparationScope,
    attemptId: string,
    route: CliPreparationRoute,
    submit: boolean,
  ) {
    if (this.observing.has(attemptId)) return
    this.observing.add(attemptId)
    try {
      let campaign = this.campaign(scope)
      let attempt = campaign.attempts.find((item) => item.id === attemptId)!
      const spec = attempt.cliPreparationJobSpec
      if (
        !spec ||
        !attempt.cliPreparationJobSpecHash ||
        ['completed', 'failed', 'interrupted', 'cancelled'].includes(attempt.status)
      )
        return
      if (!submit) {
        this.mutate(scope, `resume-cli:${attemptId}:${campaign.version}`, {
          kind: 'resumeSyntheticObservation',
          attemptId,
          jobSpecHash: attempt.cliPreparationJobSpecHash,
        })
      } else await route.authority.submit(spec)
      const deadline = Date.now() + spec.execution.maxRuntimeMs + 30_000
      do {
        if (this.closed) return
        const job = await route.authority.query(attemptId)
        if (!job || job.specHash !== sha256(canonicalJson(spec)))
          throw new Error('Original remote job is unavailable or has changed')
        campaign = this.campaign(scope)
        attempt = campaign.attempts.find((item) => item.id === attemptId)!
        if (attempt.cancelRequestedAt !== null && job.status !== 'cancelled')
          await route.authority.cancel(attemptId)
        if (job.status === 'completed') {
          const bytes = await route.authority.receipt(attemptId)
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
          this.mutate(
            scope,
            `${attempt.cancelRequestedAt !== null ? 'quarantine' : 'finish'}-cli:${attemptId}`,
            attempt.cancelRequestedAt !== null
              ? {
                  kind: 'quarantineCliPreparationResult',
                  attemptId,
                  uri,
                  contentHash: sha256(bytes),
                  validation,
                }
              : {
                  kind: 'finishCliPreparation',
                  attemptId,
                  uri,
                  artifactKind: 'cli_preparation_candidate',
                  contentHash: sha256(bytes),
                  validation,
                },
          )
          return
        }
        if (job.status === 'cancelled') {
          this.mutate(scope, `cancelled-cli:${attemptId}`, {
            kind: 'interruptSynthetic',
            attemptId,
            reason: '远端执行者已确认准备进程停止',
          })
          return
        }
        if (job.status === 'interrupted') {
          this.mutate(scope, `interrupted-cli:${attemptId}`, {
            kind: 'interruptSynthetic',
            attemptId,
            reason: '远端准备进程已中断，费用仍待核对',
          })
          return
        }
        if (job.status === 'failed') {
          this.mutate(scope, `failed-cli:${attemptId}`, {
            kind: 'failSynthetic',
            attemptId,
            error: '远端代码准备未完成，费用仍待核对',
          })
          return
        }
        await Bun.sleep(250)
      } while (Date.now() < deadline)
      throw new Error('Observation time limit reached')
    } catch {
      const campaign = this.campaign(scope)
      const attempt = campaign.attempts.find((item) => item.id === attemptId)
      if (attempt?.status === 'running')
        this.mutate(scope, `unknown-cli:${attemptId}:${campaign.version}`, {
          kind: 'markSyntheticUnknown',
          attemptId,
          reason: '准备状态待核对；保留原运行与费用预留，不自动重投',
        })
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
