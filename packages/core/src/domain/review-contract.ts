export interface ClaimEvidenceMap {
  decision: 'supported' | 'insufficient'
  claims: { claim: string; artifactVersionIds: string[] }[]
  limitations: string[]
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value!).sort().join(',') === keys.sort().join(',')
  )
}
/** Establishes locatable claims, never the truth of model prose or human approval. */
export function parseModelReview(
  text: string,
  artifactVersionIds: readonly string[],
): ClaimEvidenceMap {
  if (text.length > 16_000) throw new Error('Review exceeds output contract')
  const value: unknown = JSON.parse(text)
  if (
    !exact(value, ['decision', 'claims', 'limitations']) ||
    !['supported', 'insufficient'].includes(String(value.decision)) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 20 ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 20 ||
    value.limitations.some((item) => typeof item !== 'string' || item.length > 1000) ||
    value.claims.some(
      (item) =>
        !exact(item, ['claim', 'artifactVersionIds']) ||
        typeof item.claim !== 'string' ||
        item.claim.length < 1 ||
        item.claim.length > 1000 ||
        !Array.isArray(item.artifactVersionIds) ||
        item.artifactVersionIds.length < 1 ||
        new Set(item.artifactVersionIds).size !== item.artifactVersionIds.length ||
        item.artifactVersionIds.some(
          (id) => typeof id !== 'string' || !artifactVersionIds.includes(id),
        ),
    ) ||
    (value.decision === 'supported' && value.claims.length === 0)
  )
    throw new Error('Review must bind each claim to supplied evidence')
  return value as unknown as ClaimEvidenceMap
}
