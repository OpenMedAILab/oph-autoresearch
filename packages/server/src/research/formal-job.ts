import { createHash } from 'node:crypto'
import type { FormalExecutionJobSpec, FormalExecutionPlan } from '@oph-autoresearch/core'
import { canonicalFormalExecutionPlan, validFormalExecutionPlan } from '@oph-autoresearch/core'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

/** Server name retained for callers; core owns the durable v4 schema. */
export type FormalOciJobSpec = FormalExecutionJobSpec

export function formalExecutionPlanHash(plan: FormalExecutionPlan) {
  return `sha256:${createHash('sha256').update(canonicalFormalExecutionPlan(plan)).digest('hex')}`
}

export function isFormalOciJob(value: unknown): value is FormalOciJobSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  const keys = Object.keys(job).sort().join(',')
  if (
    keys !==
    'campaignId,dispatchKey,execution,formalPlan,formalPlanHash,lease,taskRevisionId,version'
  )
    return false
  if (
    job.version !== 4 ||
    ![job.dispatchKey, job.campaignId, job.taskRevisionId].every(
      (item) => typeof item === 'string' && ID.test(item),
    ) ||
    !validFormalExecutionPlan(job.formalPlan) ||
    job.taskRevisionId !== job.formalPlan.taskRevisionId ||
    typeof job.formalPlanHash !== 'string' ||
    !SHA256.test(job.formalPlanHash) ||
    job.formalPlanHash !== formalExecutionPlanHash(job.formalPlan)
  )
    return false
  const lease = job.lease as Record<string, unknown> | null
  const execution = job.execution as Record<string, unknown> | null
  return Boolean(
    lease &&
      Object.keys(lease).sort().join(',') === 'expiresAt,fence,ownerId,token' &&
      typeof lease.ownerId === 'string' &&
      ID.test(lease.ownerId) &&
      typeof lease.token === 'string' &&
      ID.test(lease.token) &&
      Number.isSafeInteger(lease.fence) &&
      (lease.fence as number) >= 1 &&
      Number.isSafeInteger(lease.expiresAt) &&
      execution &&
      Object.keys(execution).sort().join(',') === 'adapter,authorityEpoch,containerName' &&
      execution.adapter === 'formal-rootless-oci-v1' &&
      typeof execution.containerName === 'string' &&
      ID.test(execution.containerName) &&
      typeof execution.authorityEpoch === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(execution.authorityEpoch),
  )
}
