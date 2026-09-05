export type ResearchExecutionBoundary = 'standard' | 'restricted-clinical'

/** Capability strings are intentionally open; unknown values must fail closed in restricted mode. */
export type ResearchCapability = string

export type ResearchCapabilityDecision = { allowed: true } | { allowed: false; message: string }

export const RESTRICTED_RESEARCH_CAPABILITY_DENIED = '研究执行受限：当前没有可信临床执行后端。'

/** Restricted clinical mode exposes only policy state, never a data or execution surface. */
export function decideResearchCapability(
  boundary: ResearchExecutionBoundary,
  capability: ResearchCapability,
): ResearchCapabilityDecision {
  if (boundary === 'standard' || capability === 'policy-status') return { allowed: true }
  return { allowed: false, message: RESTRICTED_RESEARCH_CAPABILITY_DENIED }
}
