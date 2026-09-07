import { readFileSync } from 'node:fs'
import type { SyntheticCompletionValidation } from '@oph-autoresearch/core'
import { canonicalJson, sha256 } from './skill-lock.ts'

/** Auditable non-patient phantom experiment. Both fitted models consume training labels only. */
export const SUPERVISED_PROTOCOL = Object.freeze({
  schema: 'supervised-phantom-v2' as const,
  seed: 7100,
  width: 8,
  height: 8,
  trainCount: 160,
  testCount: 80,
  epochs: 600,
  learningRate: 0.2,
  threshold: 0.5,
  models: ['training-prevalence', 'logistic-regression'] as const,
  dataClass: 'synthetic-only',
  runtimeMs: 600_000,
})
export const SUPERVISED_CODE_HASH = sha256(readFileSync(new URL(import.meta.url)))
export const SUPERVISED_INPUT_HASH = sha256(canonicalJson(SUPERVISED_PROTOCOL))
export const SUPERVISED_BINDING = Object.freeze({
  id: 'oph-supervised-phantom',
  version: 2,
  sourceHash: SUPERVISED_CODE_HASH,
  evaluationHash: sha256('supervised-phantom-v2:independent-prediction-recomputation'),
  templateId: SUPERVISED_PROTOCOL.schema,
  templateHash: SUPERVISED_INPUT_HASH,
})

type Sample = { id: string; split: 'train' | 'test'; label: number; pixels: number[] }
function data(): Sample[] {
  let seed = SUPERVISED_PROTOCOL.seed
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  return Array.from(
    { length: SUPERVISED_PROTOCOL.trainCount + SUPERVISED_PROTOCOL.testCount },
    (_, i) => {
      const label = random() > 0.5 ? 1 : 0
      const pixels = Array.from({ length: 64 }, (_, pixel) => {
        const signal = pixel % 8 < 4 ? label * 55 : (1 - label) * 35
        return Math.round(45 + signal + random() * 130)
      })
      return {
        id: `phantom-${i}`,
        split: i < SUPERVISED_PROTOCOL.trainCount ? 'train' : 'test',
        label,
        pixels,
      }
    },
  )
}
function features(sample: Sample): number[] {
  return [
    1,
    ...[0, 1, 2, 3].map((quadrant) => {
      const pixels = sample.pixels.filter(
        (_, i) => (i % 8 < 4 ? 0 : 1) + (i < 32 ? 0 : 2) === quadrant,
      )
      return pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length / 255
    }),
  ]
}
function predict(weights: number[], input: number[]): number {
  const logit = input.reduce((sum, feature, i) => sum + feature * weights[i]!, 0)
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))))
}
function fit(samples: Sample[]) {
  const rows = samples.map((sample) => ({ x: features(sample), y: sample.label }))
  const weights = [0, 0, 0, 0, 0]
  const losses: number[] = []
  for (let epoch = 0; epoch < SUPERVISED_PROTOCOL.epochs; epoch++) {
    const gradient = [0, 0, 0, 0, 0]
    let loss = 0
    for (const row of rows) {
      const score = predict(weights, row.x)
      loss -=
        row.y * Math.log(Math.max(score, 1e-12)) +
        (1 - row.y) * Math.log(Math.max(1 - score, 1e-12))
      for (let j = 0; j < weights.length; j++) gradient[j]! += (score - row.y) * row.x[j]!
    }
    if (epoch === 0 || epoch === SUPERVISED_PROTOCOL.epochs - 1) losses.push(loss / rows.length)
    for (let j = 0; j < weights.length; j++)
      weights[j]! -= (SUPERVISED_PROTOCOL.learningRate * gradient[j]!) / rows.length
  }
  return { weights, trainingLoss: { first: losses[0]!, last: losses[1]! } }
}
type Prediction = { id: string; label: number; score: number }
/** Independent aggregation from the sealed per-example predictions, never supplied summary metrics. */
export function aggregatePredictions(rows: readonly Prediction[]) {
  if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('Invalid prediction IDs')
  let correct = 0,
    logLoss = 0,
    tp = 0,
    fp = 0,
    tn = 0,
    fn = 0
  for (const row of rows) {
    if (
      ![0, 1].includes(row.label) ||
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1
    )
      throw new Error('Invalid prediction')
    const positive = row.score >= SUPERVISED_PROTOCOL.threshold
    if (Number(positive) === row.label) correct++
    if (positive && row.label) tp++
    else if (positive) fp++
    else if (row.label) fn++
    else tn++
    logLoss -=
      row.label * Math.log(Math.max(row.score, 1e-12)) +
      (1 - row.label) * Math.log(Math.max(1 - row.score, 1e-12))
  }
  return {
    samples: rows.length,
    accuracy: correct / rows.length,
    logLoss: logLoss / rows.length,
    confusion: { tp, fp, tn, fn },
  }
}

export function executeSupervisedExperiment() {
  const samples = data(),
    training = samples.filter((sample) => sample.split === 'train'),
    test = samples.filter((sample) => sample.split === 'test')
  const fitted = fit(training)
  const prevalence = training.reduce((sum, sample) => sum + sample.label, 0) / training.length
  const models = [
    {
      id: 'training-prevalence',
      parameters: [prevalence],
      trainingLoss: null,
      predictions: test.map((sample) => ({
        id: sample.id,
        label: sample.label,
        score: prevalence,
      })),
    },
    {
      id: 'logistic-regression',
      parameters: fitted.weights,
      trainingLoss: fitted.trainingLoss,
      predictions: test.map((sample) => ({
        id: sample.id,
        label: sample.label,
        score: predict(fitted.weights, features(sample)),
      })),
    },
  ].map((model) => ({ ...model, metrics: aggregatePredictions(model.predictions) }))
  return {
    schema: SUPERVISED_PROTOCOL.schema,
    inputHash: SUPERVISED_INPUT_HASH,
    codeHash: SUPERVISED_CODE_HASH,
    protocol: SUPERVISED_PROTOCOL,
    datasetHash: sha256(canonicalJson(samples)),
    trainIds: training.map((sample) => sample.id),
    testIds: test.map((sample) => sample.id),
    models,
  }
}

export function verifySupervisedExperiment(bytes: Uint8Array): SyntheticCompletionValidation {
  if (bytes.byteLength > 2_000_000) throw new Error('Experiment receipt too large')
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as ReturnType<
    typeof executeSupervisedExperiment
  >
  if (
    value.schema !== SUPERVISED_PROTOCOL.schema ||
    value.inputHash !== SUPERVISED_INPUT_HASH ||
    value.codeHash !== SUPERVISED_CODE_HASH ||
    canonicalJson(value.protocol) !== canonicalJson(SUPERVISED_PROTOCOL)
  )
    throw new Error('Experiment provenance mismatch')
  const samples = data(),
    training = samples.filter((sample) => sample.split === 'train'),
    test = samples.filter((sample) => sample.split === 'test')
  if (
    value.datasetHash !== sha256(canonicalJson(samples)) ||
    canonicalJson(value.trainIds) !== canonicalJson(training.map((sample) => sample.id)) ||
    canonicalJson(value.testIds) !== canonicalJson(test.map((sample) => sample.id))
  )
    throw new Error('Dataset or partition mismatch')
  if (value.models?.length !== 2) throw new Error('Both registered models are required')
  const expectedFit = fit(training)
  for (let index = 0; index < 2; index++) {
    const model = value.models[index]!
    const parameters =
      index === 0
        ? [training.reduce((sum, sample) => sum + sample.label, 0) / training.length]
        : expectedFit.weights
    const predictions = test.map((sample) => ({
      id: sample.id,
      label: sample.label,
      score: index === 0 ? parameters[0]! : predict(parameters, features(sample)),
    }))
    if (
      model.id !== SUPERVISED_PROTOCOL.models[index] ||
      canonicalJson(model.parameters) !== canonicalJson(parameters) ||
      canonicalJson(model.predictions) !== canonicalJson(predictions) ||
      canonicalJson(model.metrics) !== canonicalJson(aggregatePredictions(predictions)) ||
      canonicalJson(model.trainingLoss) !==
        canonicalJson(index === 0 ? null : expectedFit.trainingLoss)
    )
      throw new Error('Training result or independently recomputed metrics mismatch')
  }
  return {
    inputHash: value.inputHash,
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength,
    verifiedAt: Date.now(),
  }
}
