import { describe, expect, test } from 'bun:test'
import {
  canonicalLabelSetHash,
  changeImpact,
  validateLabelSetReference,
  validateLabelSetSuccessor,
} from './labelset.ts'

function ref(over: Record<string, unknown> = {}) {
  return {
    schema: 'labelset-reference-v1',
    id: '123e4567-e89b-42d3-a456-426614174000',
    version: 1,
    contentHash: `sha256:${'a'.repeat(64)}`,
    datasetSnapshotHash: `sha256:${'b'.repeat(64)}`,
    annotationSchemaHash: `sha256:${'c'.repeat(64)}`,
    aggregate: { subjects: 2, observations: 3, classes: { negative: 1, positive: 2 } },
    issuer: 'configured-signer',
    issuedAt: 1,
    ...over,
  }
}
describe('immutable aggregate LabelSet references', () => {
  test('rejects patient, row, path, URL and unknown canary fields', () => {
    for (const field of ['patients', 'rows', 'names', 'url', 'path', 'notes', 'canary'])
      expect(() => validateLabelSetReference({ ...ref(), [field]: 'private-canary' })).toThrow(
        'schema',
      )
  })
  test('enforces finite nonnegative aggregate counts and their exact observation total', () => {
    expect(() =>
      validateLabelSetReference(
        ref({ aggregate: { subjects: 2, observations: 3, classes: { positive: 2 } } }),
      ),
    ).toThrow('class counts')
    expect(() =>
      validateLabelSetReference(
        ref({ aggregate: { subjects: 4, observations: 3, classes: { positive: 3 } } }),
      ),
    ).toThrow('counts')
    expect(() =>
      validateLabelSetReference(
        ref({ aggregate: { subjects: 1, observations: 1, classes: { positive: Number.NaN } } }),
      ),
    ).toThrow('class count')
    expect(canonicalLabelSetHash(validateLabelSetReference(ref()))).toMatch(/^sha256:/)
  })
  test('accepts only an immutable immediate successor', () => {
    const first = validateLabelSetReference(ref())
    const second = ref({
      version: 2,
      previousContentHash: first.contentHash,
      contentHash: `sha256:${'d'.repeat(64)}`,
    })
    expect(validateLabelSetSuccessor(first, second)).toMatchObject({ version: 2 })
    expect(() =>
      validateLabelSetSuccessor(
        first,
        ref({ version: 2, previousContentHash: `sha256:${'0'.repeat(64)}` }),
      ),
    ).toThrow('successor')
    expect(() =>
      validateLabelSetReference(ref({ previousContentHash: first.contentHash })),
    ).toThrow('predecessor')
  })
  test('returns only explicitly linked artifact versions in the change closure', () => {
    const first = ref()
    const second = ref({
      version: 2,
      previousContentHash: first.contentHash,
      contentHash: `sha256:${'d'.repeat(64)}`,
    })
    expect(
      changeImpact(first, second, [
        {
          labelSetId: first.id,
          labelSetContentHash: first.contentHash,
          artifactVersionId: 'rav-affected',
        },
        {
          labelSetId: first.id,
          labelSetContentHash: `sha256:${'e'.repeat(64)}`,
          artifactVersionId: 'rav-other-version',
        },
        {
          labelSetId: '123e4567-e89b-42d3-a456-426614174001',
          labelSetContentHash: first.contentHash,
          artifactVersionId: 'rav-other-set',
        },
      ]),
    ).toEqual([
      {
        artifactVersionId: 'rav-affected',
        labelSetId: first.id,
        previousContentHash: first.contentHash,
        nextContentHash: second.contentHash,
      },
    ])
  })
})
