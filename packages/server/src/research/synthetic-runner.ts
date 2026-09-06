import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResearchCampaign, ResearchTemplateId } from '@oph-autoresearch/core'
import {
  getResearchCampaign,
  mutateResearchCampaign,
  recoverRunningSyntheticAttempts,
  type Store,
} from '@oph-autoresearch/store'
import {
  executeDaemonAttempt,
  matchesExecutionAuthority,
  observeDaemonAttempt,
  type ResearchDaemonBackend,
  verifyDaemonReceipt,
} from './daemon-execution.ts'
import { type FixedResearchTemplate, fixedResearchTemplate } from './template-registry.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export interface StartSyntheticRunInput {
  daemonBackend?: ResearchDaemonBackend
  approvalId?: string
  requireApproval?: boolean
  templateId?: ResearchTemplateId
  taskRevisionId?: string
  store: Store
  workspaceRoot: string
  campaignId: string
  expectedVersion: number
  dispatchKey: string
  onChange?: (campaign: ResearchCampaign) => void
}

export interface CancelSyntheticRunInput {
  daemonBackend?: ResearchDaemonBackend
  store: Store
  campaignId: string
  expectedVersion: number
  attemptId: string
  onChange?: (campaign: ResearchCampaign) => void
}

export type SyntheticRunResult =
  | { ok: true; campaign: ResearchCampaign; attemptId: string; replayed: boolean }
  | { ok: false; error: string; code?: string; campaign?: ResearchCampaign; attemptId?: string }

export interface SyntheticRunnerTestHooks {
  /** Test-only override used to prove invalid skill provenance cannot reach the ledger or filesystem. */
  skillManifest?: unknown
  beforeWrite?: (input: {
    campaignId: string
    attemptId: string
    outputPath: string
  }) => Promise<void> | void
}

const active = new Map<string, AbortController>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertId(value: string, name: string): void {
  if (!ID.test(value)) throw new Error(`${name} 不合法`)
}

async function safeOutputPath(
  workspaceRoot: string,
  campaignId: string,
  attemptId: string,
  filename: FixedResearchTemplate['filename'],
  allowExisting = false,
): Promise<string> {
  assertId(campaignId, 'campaignId')
  assertId(attemptId, 'attemptId')
  let current = await realpath(resolve(workspaceRoot))
  for (const segment of ['.oph', 'research', campaignId, attemptId]) {
    const next = join(current, segment)
    const existing = await lstat(next).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`研究输出目录包含不安全路径：${segment}`)
      }
    } else {
      await mkdir(next).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const created = await lstat(next)
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`研究输出目录包含不安全路径：${segment}`)
      }
    }
    current = next
  }
  const output = join(current, filename)
  const existing = await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing && (!allowExisting || existing.isSymbolicLink() || !existing.isFile()))
    throw new Error('Attempt output already exists or is unsafe')
  return output
}

function notify(
  input: { onChange?: (campaign: ResearchCampaign) => void },
  campaign: ResearchCampaign,
): void {
  try {
    input.onChange?.(campaign)
  } catch {
    console.error('research campaign notification failed')
  }
}

function failure(
  input: StartSyntheticRunInput,
  attemptId: string,
  error: string,
): SyntheticRunResult {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) return { ok: false, error, attemptId }
  const result = mutateResearchCampaign(input.store, input.campaignId, {
    idempotencyKey: `synthetic-fail:${attemptId}:${campaign.version}`,
    expectedVersion: campaign.version,
    command: { kind: 'failSynthetic', attemptId, error },
  })
  if (!result.ok)
    return { ok: false, error: result.message, code: result.code, campaign, attemptId }
  notify(input, result.campaign)
  return { ok: false, error, campaign: result.campaign, attemptId }
}

function interrupt(
  input: StartSyntheticRunInput,
  attemptId: string,
  reason: string,
): SyntheticRunResult {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) return { ok: false, error: reason, attemptId }
  const result = mutateResearchCampaign(input.store, input.campaignId, {
    idempotencyKey: `synthetic-interrupt:${attemptId}:${campaign.version}`,
    expectedVersion: campaign.version,
    command: { kind: 'interruptSynthetic', attemptId, reason },
  })
  if (!result.ok)
    return { ok: false, error: result.message, code: result.code, campaign, attemptId }
  notify(input, result.campaign)
  return { ok: false, error: reason, campaign: result.campaign, attemptId }
}

export async function startSyntheticRun(
  input: StartSyntheticRunInput,
  hooks: SyntheticRunnerTestHooks = {},
): Promise<SyntheticRunResult> {
  const claimed = await claimSyntheticRun(input, hooks)
  if ('result' in claimed) return claimed.result
  return completeClaimedSyntheticRun(input, hooks, claimed)
}

/**
 * Returns only after the immutable attempt claim is durable.  The detached
 * completion retains the normal runner's cancellation map and ledger writes;
 * callers can immediately inspect, cancel, reconcile, or fetch its receipt.
 */
export async function startSyntheticRunBackground(
  input: StartSyntheticRunInput,
  hooks: SyntheticRunnerTestHooks = {},
): Promise<SyntheticRunResult> {
  const claimed = await claimSyntheticRun(input, hooks)
  if ('result' in claimed) return claimed.result
  void completeClaimedSyntheticRun(input, hooks, claimed).catch(() => {
    console.error('research background completion failed to persist', claimed.attempt.id)
  })
  return {
    ok: true,
    campaign: claimed.claim.campaign,
    attemptId: claimed.attempt.id,
    replayed: false,
  }
}

async function claimSyntheticRun(input: StartSyntheticRunInput, hooks: SyntheticRunnerTestHooks) {
  let inputHash: string
  let plan: FixedResearchTemplate
  try {
    plan = fixedResearchTemplate(input.templateId)
    await plan.assertSkill(hooks.skillManifest)
    recoverRunningSyntheticAttempts(input.store)
    inputHash = plan.inputHash?.() ?? plan.execute().inputHash
    if (plan.id === 'supervised-phantom-v2' && (!input.daemonBackend || !input.approvalId))
      throw new Error('真实训练需要守护进程和任务绑定审批')
    assertId(input.campaignId, 'campaignId')
    assertId(input.dispatchKey, 'dispatchKey')
  } catch (error) {
    return {
      result: {
        ok: false,
        error: errorMessage(error),
        code: 'invalid_synthetic_runner_input',
      } as SyntheticRunResult,
    }
  }

  const claim = mutateResearchCampaign(input.store, input.campaignId, {
    idempotencyKey: `synthetic-claim:${input.dispatchKey}:${input.expectedVersion}`,
    expectedVersion: input.expectedVersion,
    command: {
      kind: 'claimSynthetic',
      ...(input.daemonBackend?.daemon.trackingPolicyHash
        ? { trackingPolicyHash: input.daemonBackend.daemon.trackingPolicyHash }
        : {}),
      ...(input.daemonBackend?.daemon.backendPolicyHash
        ? { backendPolicyHash: input.daemonBackend.daemon.backendPolicyHash }
        : {}),
      backend: input.daemonBackend
        ? (input.daemonBackend.kind ?? 'localhost-daemon')
        : 'builtin-local',
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.requireApproval ? { requireApproval: true } : {}),
      templateId: plan.id,
      skillBinding: plan.binding,
      ...(input.taskRevisionId ? { taskRevisionId: input.taskRevisionId } : {}),
      dispatchKey: input.dispatchKey,
      inputHash,
    },
  })
  if (!claim.ok)
    return { result: { ok: false, error: claim.message, code: claim.code } as SyntheticRunResult }
  notify(input, claim.campaign)
  const attempt = claim.campaign.attempts.find(
    (candidate) => candidate.dispatchKey === input.dispatchKey,
  )
  if (!attempt)
    return {
      result: {
        ok: false,
        error: '账本没有返回合成尝试',
        code: 'missing_attempt',
      } as SyntheticRunResult,
    }
  if (claim.replayed)
    return {
      result: {
        ok: true,
        campaign: claim.campaign,
        attemptId: attempt.id,
        replayed: true,
      } as SyntheticRunResult,
    }

  return { claim, attempt, plan }
}

async function completeClaimedSyntheticRun(
  input: StartSyntheticRunInput,
  hooks: SyntheticRunnerTestHooks,
  claimed: {
    claim: Extract<Awaited<ReturnType<typeof mutateResearchCampaign>>, { ok: true }>
    attempt: NonNullable<ResearchCampaign['attempts'][number]>
    plan: FixedResearchTemplate
  },
): Promise<SyntheticRunResult> {
  const { attempt, plan } = claimed
  const controller = new AbortController()
  active.set(attempt.id, controller)
  try {
    let outputBytes: Uint8Array | undefined
    if (input.daemonBackend) {
      const observed = await executeDaemonAttempt({
        store: input.store,
        campaignId: input.campaignId,
        attempt,
        backend: input.daemonBackend,
        signal: controller.signal,
        onChange: (c) => notify(input, c),
      })
      if (observed.status === 'unknown') return markUnknown(input, attempt.id, observed.reason)
      if (observed.status !== 'completed') return interrupt(input, attempt.id, observed.reason)
      outputBytes = observed.bytes
      const durable = getResearchCampaign(input.store, input.campaignId)!.attempts.find(
        (a) => a.id === attempt.id,
      )
      if (!durable?.jobSpec) throw new Error('Missing durable execution receipt binding')
      verifyDaemonReceipt(outputBytes, durable.jobSpec)
    }
    const outputPath = await safeOutputPath(
      input.workspaceRoot,
      input.campaignId,
      attempt.id,
      plan.filename,
    )
    await hooks.beforeWrite?.({ campaignId: input.campaignId, attemptId: attempt.id, outputPath })
    if (controller.signal.aborted) return interrupt(input, attempt.id, '合成运行已取消')
    await writeFile(outputPath, outputBytes ?? `${JSON.stringify(plan.execute(), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    if (controller.signal.aborted) return interrupt(input, attempt.id, '合成运行已取消')

    const bytes = await readFile(outputPath)
    const validation = plan.verify(bytes)
    const contentHash = validation.contentHash
    const current = getResearchCampaign(input.store, input.campaignId)
    if (!current) {
      return {
        ok: false,
        error: '找不到 research campaign',
        code: 'not_found',
        attemptId: attempt.id,
      }
    }
    const finished = mutateResearchCampaign(input.store, input.campaignId, {
      idempotencyKey: `synthetic-finish:${attempt.id}:${current.version}`,
      expectedVersion: current.version,
      command: {
        kind: 'finishSynthetic',
        attemptId: attempt.id,
        contentHash,
        uri: pathToFileURL(outputPath).href,
        artifactKind: plan.id,
        validation,
      },
    })
    if (!finished.ok) {
      if (finished.code === 'cancel_requested')
        return interrupt(input, attempt.id, '合成运行已取消')
      return failure(input, attempt.id, finished.message)
    }
    notify(input, finished.campaign)
    return { ok: true, campaign: finished.campaign, attemptId: attempt.id, replayed: false }
  } catch (error) {
    if (input.daemonBackend) return markUnknown(input, attempt.id, errorMessage(error))
    return controller.signal.aborted
      ? interrupt(input, attempt.id, '合成运行已取消')
      : failure(input, attempt.id, errorMessage(error))
  } finally {
    active.delete(attempt.id)
  }
}

function markUnknown(
  input: StartSyntheticRunInput,
  attemptId: string,
  reason: string,
): SyntheticRunResult {
  const current = getResearchCampaign(input.store, input.campaignId)!
  const result = mutateResearchCampaign(input.store, current.id, {
    expectedVersion: current.version,
    idempotencyKey: `unknown:${attemptId}:${current.version}`,
    command: { kind: 'markSyntheticUnknown', attemptId, reason },
  })
  if (result.ok) notify(input, result.campaign)
  return {
    ok: false,
    code: 'execution_unknown',
    error: reason,
    attemptId,
    campaign: result.ok ? result.campaign : current,
  }
}

export async function reconcileSyntheticRun(
  input: CancelSyntheticRunInput & { workspaceRoot: string },
): Promise<SyntheticRunResult> {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  const attempt = campaign?.attempts.find((a) => a.id === input.attemptId)
  if (!campaign || !attempt || !input.daemonBackend)
    return { ok: false, code: 'backend_unavailable', error: 'No daemon observation available' }
  if (!['unknown', 'running'].includes(attempt.status))
    return { ok: true, campaign, attemptId: attempt.id, replayed: true }
  const runInput = { ...input, dispatchKey: attempt.dispatchKey }
  try {
    const observed = await observeDaemonAttempt(input.daemonBackend, attempt)
    if (observed.status === 'unknown') return markUnknown(runInput, attempt.id, observed.reason)
    const resumed = mutateResearchCampaign(input.store, campaign.id, {
      expectedVersion: campaign.version,
      idempotencyKey: `observe:${attempt.id}:${campaign.version}`,
      command: {
        kind: 'resumeSyntheticObservation',
        attemptId: attempt.id,
        jobSpecHash: attempt.jobSpecHash!,
      },
    })
    if (!resumed.ok) return { ok: false, code: resumed.code, error: resumed.message }
    notify(input, resumed.campaign)
    if (observed.status !== 'completed' || attempt.cancelRequestedAt !== null)
      return interrupt(
        runInput,
        attempt.id,
        'Daemon terminal state confirmed; cancelled output is not accepted',
      )
    const task = resumed.campaign.taskRevisions.find((t) => t.id === attempt.taskRevisionId)!
    const plan = fixedResearchTemplate(task.templateId)
    verifyDaemonReceipt(observed.bytes, attempt.jobSpec!)
    const path = await safeOutputPath(
      input.workspaceRoot,
      campaign.id,
      attempt.id,
      plan.filename,
      true,
    )
    try {
      await writeFile(path, observed.bytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const validation = plan.verify(await readFile(path))
    const latest = getResearchCampaign(input.store, campaign.id)!
    const finish = mutateResearchCampaign(input.store, campaign.id, {
      expectedVersion: latest.version,
      idempotencyKey: `reconciled-finish:${attempt.id}:${latest.version}`,
      command: {
        kind: 'finishSynthetic',
        attemptId: attempt.id,
        contentHash: validation.contentHash,
        uri: pathToFileURL(path).href,
        artifactKind: plan.id,
        validation,
      },
    })
    if (!finish.ok) return failure(runInput, attempt.id, finish.message)
    notify(input, finish.campaign)
    return { ok: true, campaign: finish.campaign, attemptId: attempt.id, replayed: false }
  } catch (error) {
    return markUnknown(runInput, attempt.id, errorMessage(error))
  }
}

export function cancelSyntheticRun(input: CancelSyntheticRunInput): SyntheticRunResult {
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) {
    return {
      ok: false,
      error: '找不到 research campaign',
      code: 'not_found',
      attemptId: input.attemptId,
    }
  }
  const attempt = campaign.attempts.find((candidate) => candidate.id === input.attemptId)
  if (!attempt) {
    return {
      ok: false,
      error: '找不到 attemptId',
      code: 'unknown_attempt',
      campaign,
      attemptId: input.attemptId,
    }
  }
  if (attempt.cancelRequestedAt !== null) {
    return { ok: true, campaign, attemptId: attempt.id, replayed: true }
  }
  const cancelled = mutateResearchCampaign(input.store, input.campaignId, {
    idempotencyKey: `synthetic-cancel:${input.attemptId}:${input.expectedVersion}`,
    expectedVersion: input.expectedVersion,
    command: { kind: 'requestCancelSynthetic', attemptId: input.attemptId },
  })
  if (!cancelled.ok) {
    return {
      ok: false,
      error: cancelled.message,
      code: cancelled.code,
      campaign,
      attemptId: input.attemptId,
    }
  }
  notify(input, cancelled.campaign)
  const controller = active.get(input.attemptId)
  if (controller) {
    controller.abort()
  } else if (attempt.backend === 'localhost-daemon' || attempt.backend === 'ssh-daemon') {
    if (
      attempt.jobSpec &&
      input.daemonBackend &&
      matchesExecutionAuthority(input.daemonBackend, attempt)
    )
      void Promise.resolve(input.daemonBackend.daemon.cancel(attempt.jobSpec.dispatchKey)).catch(
        () => {},
      )
  } else {
    recoverRunningSyntheticAttempts(input.store)
  }
  const current = getResearchCampaign(input.store, input.campaignId) ?? cancelled.campaign
  if (current.version !== cancelled.campaign.version) notify(input, current)
  return {
    ok: true,
    campaign: current,
    attemptId: input.attemptId,
    replayed: cancelled.replayed,
  }
}
