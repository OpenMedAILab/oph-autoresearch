import { describe, expect, test } from 'bun:test'
import fixture from '../../../../fixtures/synthetic-evaluation.json'
import { EVALUATION_PROTOCOL, evaluateSynthetic } from './evaluation.ts'

function input() {
  return structuredClone(fixture)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex')}`
}

function sealed(value: ReturnType<typeof input>) {
  const partition = (split: 'train' | 'validation' | 'test') =>
    hash(
      value.rows
        .filter((row) => row.split === split)
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    )
  value.provenance.preprocessingTrainingPartitionHash = partition('train')
  value.provenance.thresholdValidationPartitionHash = partition('validation')
  value.provenance.frozenTestPartitionHash = partition('test')
  value.provenance.protocolHash = hash(EVALUATION_PROTOCOL)
  return value
}

describe('synthetic-evaluation-v1', () => {
  test('reports aggregate test metrics with a validation-only threshold and patient clusters', () => {
    const report = evaluateSynthetic(input())
    expect(report.threshold).toMatchObject({ value: 0.8, selectionSplit: 'validation', youdenJ: 1 })
    expect(report.metrics).toEqual({
      auroc: { value: 1 },
      sensitivity: { value: 0.75 },
      specificity: { value: 1 },
      accuracy: { value: 6 / 7 },
    })
    expect(report.groupCounts.test).toEqual({
      observations: 7,
      patients: 4,
      patientEyes: 6,
      duplicateGroups: 4,
    })
    expect(report.confusion).toEqual({
      truePositive: 3,
      trueNegative: 3,
      falsePositive: 0,
      falseNegative: 1,
    })
    expect(report.bootstrap).toMatchObject({
      unit: 'patient',
      repetitions: 200,
      confidenceLevel: 0.95,
    })
    expect(JSON.stringify(report)).not.toContain('test-a')
    expect(report.provenanceHashes.rowsSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('is deterministic and bootstrap samples patients rather than individual eyes or visits', () => {
    const first = evaluateSynthetic(input())
    const second = evaluateSynthetic(input())
    expect(second).toEqual(first)
    expect(first.protocol.bootstrap.unit).toBe('patient')
    expect(first.confidenceIntervals.accuracy.effectiveRepetitions).toBe(200)
  })

  test('does not choose a threshold from test scores', () => {
    const changed = input()
    for (const row of changed.rows) if (row.split === 'test') row.score = 1 - row.score
    expect(evaluateSynthetic(sealed(changed)).threshold.value).toBe(
      evaluateSynthetic(input()).threshold.value,
    )
  })

  test('rejects provenance hashes that do not bind the exact split rows or fixed protocol', () => {
    const changedRows = input()
    changedRows.rows[0]!.score = 0.11
    expect(() => evaluateSynthetic(changedRows)).toThrow(
      /TrainingPartitionHash does not match train rows/,
    )
    const changedProtocol = input()
    changedProtocol.provenance.protocolHash = `sha256:${'0'.repeat(64)}`
    expect(() => evaluateSynthetic(changedProtocol)).toThrow(
      /protocolHash does not match fixed protocol/,
    )
  })

  test.each([
    [
      'patient',
      (v: ReturnType<typeof input>) => {
        v.rows[0]!.patientId = v.rows[2]!.patientId
        v.rows[0]!.eye = 'R'
        v.rows[0]!.visitId = 'v2'
      },
    ],
    [
      'duplicate group',
      (v: ReturnType<typeof input>) => {
        v.rows[0]!.duplicateGroupId = v.rows[2]!.duplicateGroupId
      },
    ],
  ])('rejects %s leakage across splits', (_name, alter) => {
    const leaked = input()
    alter(leaked)
    expect(() => evaluateSynthetic(sealed(leaked))).toThrow(/crosses splits/)
  })

  test('rejects non-finite or out-of-range scores and duplicate observations', () => {
    const invalid = input()
    invalid.rows[0]!.score = Number.NaN
    expect(() => evaluateSynthetic(sealed(invalid))).toThrow(/finite/)
    const duplicate = input()
    duplicate.rows[1]!.id = duplicate.rows[0]!.id
    expect(() => evaluateSynthetic(sealed(duplicate))).toThrow(/duplicate observation id/)
  })

  test('keeps single-class test AUROC undefined rather than inventing 0.5', () => {
    const single = input()
    for (const row of single.rows) if (row.split === 'test') row.label = 1
    expect(evaluateSynthetic(sealed(single)).metrics.auroc).toEqual({
      value: null,
      reason: 'single_class_test',
    })
  })
})
