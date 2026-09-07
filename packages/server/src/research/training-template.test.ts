import { describe, expect, test } from 'bun:test'
import fixture from '../../../../fixtures/synthetic-features.json'
import {
  assertTrainingSkill,
  fitAndEvaluate,
  TRAINING_SKILL,
  TRAINING_SKILL_BINDING,
  trainingEvaluationOutput,
} from './training-template.ts'

function input() {
  return structuredClone(fixture)
}

function changeFeature(value: ReturnType<typeof input>, id: string, feature: number) {
  const row = value.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`Missing fixture row ${id}`)
  row.feature = feature
}

describe('synthetic-training-evaluation-v1', () => {
  test('fits preprocessing only on training features while validation and test changes alter held-out metrics', () => {
    const baseline = fitAndEvaluate(input())

    const validationChanged = input()
    changeFeature(validationChanged, 'va-1', 3)
    const validationResult = fitAndEvaluate(validationChanged)
    expect(validationResult.preprocessing).toEqual(baseline.preprocessing)
    expect(validationResult.report.metrics).not.toEqual(baseline.report.metrics)

    const testChanged = input()
    changeFeature(testChanged, 'te-7', 3)
    const testResult = fitAndEvaluate(testChanged)
    expect(testResult.preprocessing).toEqual(baseline.preprocessing)
    expect(testResult.report.metrics).not.toEqual(baseline.report.metrics)
  })

  test('changes the fitted mean and hashes when a training feature changes', () => {
    const baseline = fitAndEvaluate(input())
    const changed = input()
    changeFeature(changed, 'tr-1', -1)
    const result = fitAndEvaluate(changed)

    expect(result.preprocessing.parameters).not.toEqual(baseline.preprocessing.parameters)
    expect(result.preprocessing.parametersHash).not.toEqual(baseline.preprocessing.parametersHash)
    expect(result.preprocessing.trainingFeaturesHash).not.toEqual(
      baseline.preprocessing.trainingFeaturesHash,
    )
  })

  test('rejects invalid feature values and patient leakage across splits', () => {
    const invalid = input()
    changeFeature(invalid, 'tr-1', Number.NaN)
    expect(() => fitAndEvaluate(invalid)).toThrow(/Invalid synthetic feature/)

    const leaked = input()
    const train = leaked.rows.find((row) => row.id === 'tr-1')
    const validation = leaked.rows.find((row) => row.id === 'va-1')
    if (!train || !validation) throw new Error('Fixture lacks required rows')
    validation.patientId = train.patientId
    validation.eye = 'R'
    validation.visitId = 'v2'
    expect(() => fitAndEvaluate(leaked)).toThrow(/crosses splits/)
  })

  test('emits only the fixed aggregate report and rejects a tampered training provenance lock', async () => {
    const output = trainingEvaluationOutput()
    expect(output).toMatchObject({
      schema: 'synthetic-training-evaluation-v1',
      inputHash: TRAINING_SKILL.source.contentHash,
      preprocessing: { fitSplit: 'train', trainingObservations: 2 },
    })
    expect(TRAINING_SKILL_BINDING).toMatchObject({
      templateId: 'synthetic-training-evaluation-v1',
      sourceHash: output.inputHash,
    })
    expect(JSON.stringify(output)).not.toMatch(/"patientId"|"rows"\s*:|train-a|test-a/)

    const tampered = structuredClone(TRAINING_SKILL) as unknown as {
      source: { contentHash: string }
    }
    tampered.source.contentHash = `sha256:${'0'.repeat(64)}`
    await expect(assertTrainingSkill(tampered)).rejects.toThrow(/Invalid fixed training skill/)
  })
})
