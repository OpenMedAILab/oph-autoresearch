import type { ResearchTemplateId } from './research.ts'

export interface CliPreparationFrozenConfig {
  preparationId: string
  taskRevisionId: string
  dispatchKey: string
  candidateId: string
  adapterId: string
  adapterConfigHash: string
  backendPolicyHash: string
  model: string
  instructions: string
  inputHash: string
  deviceId: string
  maxRuntimeMs: number
  maxCost: number
  acknowledgeUnknownCost: true
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Stable bytes for the full human-approved CLI preparation proposal. */
export function canonicalCliPreparationConfig(config: CliPreparationFrozenConfig): string {
  return canonicalValue(config)
}

/** Human-approved limits for a preparation adapter; separate from executable code identity. */
export interface CliPreparationLimits {
  maxRuntimeMs: number
  cpu: 1
  memoryMb: 256
  adapterConfigHash: string
  acknowledgeUnknownCost: true
}

/**
 * Immutable remote-daemon envelope for a CLI preparation. `dispatchKey` is the
 * ledger Attempt ID; the client proposal key remains inside `execution`.
 */
export interface CliPreparationJobSpec {
  version: 3
  dispatchKey: string
  campaignId: string
  taskRevisionId: string
  templateId: ResearchTemplateId
  inputHash: string
  backendPolicyHash: string
  resource: { cpu: 1; memoryMb: 256 }
  lease: { ownerId: string; token: string; fence: number; expiresAt: number }
  execution: {
    adapter: 'cli-preparation-v1'
    codeHash?: never
    preparationId: string
    candidateId: string
    clientDispatchKey: string
    adapterId: string
    adapterConfigHash: string
    model: string
    instructions: string
    configHash: string
    deviceId: string
    maxRuntimeMs: number
    maxCost: number
  }
}

/** Trusted daemon receipt summary; it binds the candidate file bytes to the frozen envelope. */
export interface CliPreparationCandidateValidation {
  schema: 'research-cli-preparation-candidate-v1'
  jobSpecHash: string
  dispatchKey: string
  clientDispatchKey: string
  preparationId: string
  candidateId: string
  taskRevisionId: string
  inputHash: string
  configHash: string
  contentHash: string
  draftContentHash: string
  byteLength: number
  verifiedAt: number
}
