import { expect, test } from 'bun:test'
import fixture from '../../../../fixtures/synthetic-summary.json'
import { reviewSyntheticEvidence } from './synthetic-review.ts'

test('independent machine review recomputes bytes and rejects executor success claims', () => {
  const valid = {
    schema: 'synthetic-summary-v1',
    inputHash: fixture.inputHash,
    statistics: { count: 8, mean: 39.375, min: 12, max: 73 },
  }
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  expect(reviewSyntheticEvidence(bytes(valid))).toMatchObject({
    inputHash: fixture.inputHash,
    byteLength: bytes(valid).byteLength,
  })
  expect(() => reviewSyntheticEvidence(bytes({ ...valid, verified: true }))).toThrow()
  expect(() =>
    reviewSyntheticEvidence(bytes({ ...valid, statistics: { ...valid.statistics, mean: 40 } })),
  ).toThrow()
  expect(() =>
    reviewSyntheticEvidence(bytes({ ...valid, inputHash: `sha256:${'a'.repeat(64)}` })),
  ).toThrow()
  expect(() => reviewSyntheticEvidence(new TextEncoder().encode('success'))).toThrow()
})
