import type { ResearchAttempt, ResearchCampaign, ResearchJobSpec } from '@oph-autoresearch/core'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import type { DurableJob } from './job-daemon.ts'
import { verifyTrackingBinding } from './runner-tracking.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { fixedResearchTemplate } from './template-registry.ts'

export interface ResearchDaemonBackend {
  kind?: 'localhost-daemon' | 'ssh-daemon'
  daemon: ResearchExecutionAuthority
  workerArgv?: readonly string[]
}
export interface ResearchExecutionAuthority {
  trackingPolicyHash?: string | undefined
  backendPolicyHash?: string | undefined
  submit(spec: ResearchJobSpec): DurableJob | Promise<DurableJob>
  query(key: string): DurableJob | null | Promise<DurableJob | null>
  cancel(key: string): DurableJob | null | Promise<DurableJob | null>
  receipt(key: string): Uint8Array | Promise<Uint8Array>
  reconcileInterrupted(): unknown
  hasAvailableSlot(): boolean | Promise<boolean>
  launchWorker(
    key: string,
    options?: { workerArgv?: readonly string[] },
  ): Promise<{ exited: Promise<number> }>
}
export type DaemonObservation =
  | { status: 'completed'; bytes: Uint8Array }
  | { status: 'cancelled' | 'interrupted' | 'unknown'; reason: string }

export function verifyDaemonReceipt(bytes: Uint8Array, spec: ResearchJobSpec): void {
  try {
    fixedResearchTemplate(spec.templateId).verify(bytes)
    verifyTrackingBinding(bytes, spec)
  } catch {
    throw new Error('Execution authority returned an invalid receipt')
  }
}
export function matchesExecutionAuthority(
  backend: ResearchDaemonBackend,
  attempt: ResearchAttempt,
): boolean {
  return (
    backend.daemon.backendPolicyHash === attempt.backendPolicyHash &&
    backend.daemon.trackingPolicyHash === attempt.trackingPolicyHash &&
    (backend.kind ?? 'localhost-daemon') === attempt.backend
  )
}

/** Persist dispatch identity before contacting the execution authority. Never resubmits on observation. */
export async function executeDaemonAttempt(input: {
  store: Store
  campaignId: string
  attempt: ResearchAttempt
  backend: ResearchDaemonBackend
  signal: AbortSignal
  onChange?: (campaign: ResearchCampaign) => void
}): Promise<DaemonObservation> {
  if (!matchesExecutionAuthority(input.backend, input.attempt))
    return { status: 'unknown', reason: 'The original execution authority is not configured' }
  const current = getResearchCampaign(input.store, input.campaignId)!
  const task = current.taskRevisions.find((t) => t.id === input.attempt.taskRevisionId)!
  const spec: ResearchJobSpec = {
    ...(input.backend.daemon.backendPolicyHash
      ? { backendPolicyHash: input.backend.daemon.backendPolicyHash }
      : {}),
    ...(input.backend.daemon.trackingPolicyHash
      ? { trackingPolicyHash: input.backend.daemon.trackingPolicyHash }
      : {}),
    version: 1,
    dispatchKey: input.attempt.id,
    campaignId: input.campaignId,
    taskRevisionId: task.id,
    templateId: task.templateId,
    inputHash: task.inputHash,
    resource: { cpu: 1, memoryMb: 256 },
    lease: {
      ownerId: `process-${process.pid}`,
      token: crypto.randomUUID(),
      fence: 1,
      expiresAt: Date.now() + 60_000,
    },
  }
  const bound = mutateResearchCampaign(input.store, current.id, {
    expectedVersion: current.version,
    idempotencyKey: `bind-job:${input.attempt.id}`,
    command: { kind: 'bindSyntheticJob', attemptId: input.attempt.id, spec },
  })
  if (!bound.ok) throw new Error(bound.message)
  input.onChange?.(bound.campaign)
  const daemon = input.backend.daemon
  // An AbortSignal alone may mean a tab/process observer disappeared. Only a durable
  // cancellation command is allowed to reach the execution authority.
  const cancellationIsPersisted = () => {
    const latest = getResearchCampaign(input.store, input.campaignId)
    const persisted = latest?.attempts.find((candidate) => candidate.id === input.attempt.id)
    return persisted?.cancelRequestedAt !== null && persisted?.cancelRequestedAt !== undefined
  }
  const cancelIfPersisted = () => {
    if (cancellationIsPersisted())
      void Promise.resolve(daemon.cancel(spec.dispatchKey)).catch(() => {})
  }
  const observerAbort = new Promise<'observer_abort'>((resolve) => {
    input.signal.addEventListener(
      'abort',
      () => {
        if (!cancellationIsPersisted()) resolve('observer_abort')
      },
      { once: true },
    )
  })
  input.signal.addEventListener('abort', cancelIfPersisted)
  try {
    await daemon.submit(spec)
    // Losing a local observer is not a cancellation command. The remote authority owns the job.
    if (input.signal.aborted && !cancellationIsPersisted())
      return { status: 'unknown', reason: 'Local observer stopped before a terminal authority observation' }
    while (true) {
      if (input.signal.aborted && !cancellationIsPersisted())
        return { status: 'unknown', reason: 'Local observer stopped before a terminal authority observation' }
      const job = await daemon.query(spec.dispatchKey)
      if (!job)
        return { status: 'unknown', reason: 'Execution authority has no confirmed job observation' }
      if (
        job.specHash !== sha256(canonicalJson(spec)) ||
        sha256(canonicalJson(job.spec)) !== job.specHash
      )
        return {
          status: 'unknown',
          reason: 'Execution authority observation does not match the durable job binding',
        }
      if (job.status === 'completed') {
        const bytes = await daemon.receipt(spec.dispatchKey)
        verifyDaemonReceipt(bytes, spec)
        return { status: 'completed', bytes }
      }
      if (job.status === 'cancelled')
        return { status: 'cancelled', reason: 'Execution authority confirmed worker cancellation' }
      if (job.status === 'interrupted' || job.status === 'failed')
        return { status: 'interrupted', reason: 'Execution authority confirmed stopped worker' }
      if (job.status === 'queued' && (await daemon.hasAvailableSlot())) {
        const worker = await daemon.launchWorker(
          spec.dispatchKey,
          input.backend.workerArgv ? { workerArgv: input.backend.workerArgv } : {},
        )
        const deadline = job.executionDeadlineAt ?? spec.lease.expiresAt
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          worker.exited.then(() => 'exited' as const),
          new Promise<'deadline'>(resolve => {
            timer = setTimeout(() => resolve('deadline'), Math.max(1, deadline - Date.now()))
          }),
          observerAbort,
        ])
        if (timer) clearTimeout(timer)
        if (outcome === 'observer_abort')
          return { status: 'unknown', reason: 'Local observer stopped before a terminal authority observation' }
        if (outcome === 'deadline')
          return { status: 'unknown', reason: 'Execution deadline elapsed; terminal authority observation pending' }
        await daemon.reconcileInterrupted()
      } else if (job.status === 'running') {
        // This attempt owns the newly submitted job; only observation follows a lost worker acknowledgement.
        await daemon.reconcileInterrupted()
      }
      if (Date.now() >= (job.executionDeadlineAt ?? spec.lease.expiresAt))
        return { status: 'unknown', reason: 'Execution deadline elapsed; terminal authority observation pending' }
      await Bun.sleep(250)
    }
  } finally {
    input.signal.removeEventListener('abort', cancelIfPersisted)
  }
}

export async function observeDaemonAttempt(
  backend: ResearchDaemonBackend,
  attempt: ResearchAttempt,
): Promise<DaemonObservation> {
  if (!matchesExecutionAuthority(backend, attempt))
    return { status: 'unknown', reason: 'The original execution authority is not configured' }
  if (!attempt.jobSpec || !attempt.jobSpecHash)
    return { status: 'unknown', reason: 'No durable dispatch binding' }
  await backend.daemon.reconcileInterrupted()
  const job = await backend.daemon.query(attempt.jobSpec.dispatchKey)
  if (
    !job ||
    job.specHash !== attempt.jobSpecHash ||
    sha256(canonicalJson(job.spec)) !== job.specHash
  )
    return { status: 'unknown', reason: 'No matching daemon job observation' }
  if (attempt.cancelRequestedAt !== null && (job.status === 'queued' || job.status === 'running'))
    await backend.daemon.cancel(job.spec.dispatchKey)
  if (job.status === 'completed') {
    const bytes = await backend.daemon.receipt(job.spec.dispatchKey)
    verifyDaemonReceipt(bytes, attempt.jobSpec)
    return { status: 'completed', bytes }
  }
  if (job.status === 'cancelled')
    return { status: 'cancelled', reason: 'Execution authority confirmed cancellation' }
  if (job.status === 'failed' || job.status === 'interrupted')
    return { status: 'interrupted', reason: 'Execution authority confirmed stopped worker' }
  return {
    status: 'unknown',
    reason: 'Execution authority has not confirmed completion or cancellation',
  }
}
