import { expect, test } from 'bun:test'
import {
  aggregatePredictions,
  executeSupervisedExperiment,
  verifySupervisedExperiment,
} from './supervised-experiment.ts'

test('fits a classifier on synthetic training images and verifies held-out prediction metrics', () => {
  const result = executeSupervisedExperiment()
  expect(result.models[1]!.trainingLoss!.last).toBeLessThan(result.models[1]!.trainingLoss!.first)
  expect(result.models[1]!.parameters.some((weight) => weight !== 0)).toBe(true)
  expect(result.trainIds.some((id) => result.testIds.includes(id))).toBe(false)
  expect(verifySupervisedExperiment(Buffer.from(JSON.stringify(result))).inputHash).toBe(
    result.inputHash,
  )
  expect(aggregatePredictions([{ id: 'negative-result', label: 1, score: 0.1 }]).accuracy).toBe(0)
})

test('rejects altered metrics, labels, weights, missing baseline and stale code', () => {
  const original = executeSupervisedExperiment()
  const mutations = [
    (result: typeof original) => {
      result.models[1]!.metrics.accuracy = 0.123
    },
    (result: typeof original) => {
      result.models[1]!.predictions[0]!.label = 1 - result.models[1]!.predictions[0]!.label
    },
    (result: typeof original) => {
      result.models[1]!.parameters[0]! += 1
    },
    (result: typeof original) => {
      result.models.pop()
    },
    (result: typeof original) => {
      result.codeHash = 'sha256:' + 'a'.repeat(64)
    },
  ]
  for (const mutate of mutations) {
    const result = structuredClone(original)
    mutate(result)
    expect(() => verifySupervisedExperiment(Buffer.from(JSON.stringify(result)))).toThrow()
  }
})
