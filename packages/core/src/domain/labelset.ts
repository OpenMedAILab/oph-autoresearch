export interface LabelSetReference {
  schema: 'labelset-reference-v1'
  id: string
  version: number
  previousContentHash?: string
  contentHash: string
  datasetSnapshotHash: string
  annotationSchemaHash: string
  aggregate: { subjects: number; observations: number; classes: Record<string, number> }
  issuer: string
  issuedAt: number
}
export interface DependencyEdge {
  labelSetId: string
  labelSetContentHash: string
  artifactVersionId: string
}
const HASH = /^sha256:[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISSUER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`
}
export function canonicalLabelSetReference(reference: LabelSetReference): string {
  return canonical(reference)
}
export function validateLabelSetReference(input: unknown): LabelSetReference {
  if (
    !record(input) ||
    !exact(
      input,
      [
        'aggregate',
        'annotationSchemaHash',
        'contentHash',
        'datasetSnapshotHash',
        'id',
        'issuer',
        'issuedAt',
        'previousContentHash',
        'schema',
        'version',
      ].filter((key) => key in input),
    )
  )
    throw new Error('Invalid LabelSetReference schema')
  if (
    !record(input.aggregate) ||
    !exact(input.aggregate, ['classes', 'observations', 'subjects']) ||
    !record(input.aggregate.classes)
  )
    throw new Error('Invalid LabelSetReference aggregate')
  const reference = input as unknown as LabelSetReference
  if (
    reference.schema !== 'labelset-reference-v1' ||
    !UUID.test(reference.id) ||
    !Number.isSafeInteger(reference.version) ||
    reference.version < 1 ||
    !HASH.test(reference.contentHash) ||
    !HASH.test(reference.datasetSnapshotHash) ||
    !HASH.test(reference.annotationSchemaHash) ||
    !ISSUER.test(reference.issuer) ||
    !Number.isSafeInteger(reference.issuedAt) ||
    reference.issuedAt < 0
  )
    throw new Error('Invalid LabelSetReference values')
  if (
    reference.version === 1
      ? reference.previousContentHash !== undefined
      : !HASH.test(reference.previousContentHash ?? '')
  )
    throw new Error('Invalid LabelSetReference predecessor')
  const { subjects, observations, classes } = reference.aggregate
  if (
    !Number.isSafeInteger(subjects) ||
    !Number.isSafeInteger(observations) ||
    subjects < 0 ||
    observations < 0 ||
    subjects > observations
  )
    throw new Error('Invalid LabelSetReference counts')
  let total = 0
  for (const [label, count] of Object.entries(classes)) {
    if (
      !/^(negative|positive|uncertain|ungradable|class_[0-9]{1,3})$/.test(label) ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new Error('Invalid LabelSetReference class count')
    total += count
  }
  if (total !== observations) throw new Error('LabelSet class counts must equal observations')
  return Object.freeze(structuredClone(reference))
}
export function validateLabelSetSuccessor(previous: unknown, next: unknown): LabelSetReference {
  const prior = validateLabelSetReference(previous)
  const successor = validateLabelSetReference(next)
  if (
    successor.id !== prior.id ||
    successor.version !== prior.version + 1 ||
    successor.previousContentHash !== prior.contentHash
  )
    throw new Error('Invalid immutable LabelSet successor')
  return successor
}
export function changeImpact(previous: unknown, next: unknown, edges: readonly DependencyEdge[]) {
  const prior = validateLabelSetReference(previous)
  const successor = validateLabelSetSuccessor(prior, next)
  return edges
    .filter(
      (edge) => edge.labelSetId === prior.id && edge.labelSetContentHash === prior.contentHash,
    )
    .map((edge) => ({
      artifactVersionId: edge.artifactVersionId,
      labelSetId: successor.id,
      previousContentHash: prior.contentHash,
      nextContentHash: successor.contentHash,
    }))
}
