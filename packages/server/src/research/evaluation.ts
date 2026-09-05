/** Fixed, local-only evaluation of already generated synthetic classification scores. */

export const EVALUATION_PROTOCOL = {
  id: 'synthetic-evaluation-v1',
  threshold: { selectionSplit: 'validation', rule: 'youden_j', tieBreak: 'lowest_threshold' },
  bootstrap: {
    unit: 'patient',
    seed: 0x5eedc0de,
    repetitions: 200,
    confidenceLevel: 0.95,
    minEffectiveRatio: 0.8,
  },
} as const

export interface EvaluationRow {
  id: string
  patientId: string
  eye: 'L' | 'R'
  visitId: string
  duplicateGroupId: string
  split: 'train' | 'validation' | 'test'
  label: 0 | 1
  score: number
}

export interface EvaluationInput {
  rows: EvaluationRow[]
  provenance: {
    preprocessingFitSplit: 'train'
    preprocessingTrainingPartitionHash: string
    thresholdSelectionSplit: 'validation'
    thresholdValidationPartitionHash: string
    testFrozen: true
    frozenTestPartitionHash: string
    protocolHash: string
  }
}

type MetricName = 'auroc' | 'sensitivity' | 'specificity' | 'accuracy'
export interface MetricValue {
  value: number | null
  reason?: 'single_class_test'
}
export interface BootstrapInterval {
  lower: number | null
  upper: number | null
  effectiveRepetitions: number
  reason?: 'insufficient_valid_bootstrap_replicates'
}
export interface EvaluationReport {
  protocol: typeof EVALUATION_PROTOCOL
  threshold: { value: number; selectionSplit: 'validation'; youdenJ: number }
  metrics: Record<MetricName, MetricValue>
  confusion: {
    truePositive: number
    trueNegative: number
    falsePositive: number
    falseNegative: number
  }
  confidenceIntervals: Record<MetricName, BootstrapInterval>
  bootstrap: typeof EVALUATION_PROTOCOL.bootstrap
  groupCounts: Record<
    EvaluationRow['split'],
    {
      observations: number
      patients: number
      patientEyes: number
      duplicateGroups: number
    }
  >
  method: {
    scoreRange: '[0,1]'
    testEvaluation: 'threshold_fixed_from_validation'
    bootstrapUnit: 'patient'
  }
  provenanceHashes: {
    rowsSha256: string
    provenanceSha256: string
    protocolSha256: string
    preprocessingTrainingPartitionSha256: string
    thresholdValidationPartitionSha256: string
    frozenTestPartitionSha256: string
  }
}

const SPLITS = ['train', 'validation', 'test'] as const
const METRICS: MetricName[] = ['auroc', 'sensitivity', 'specificity', 'accuracy']

function fail(message: string): never {
  throw new Error(`synthetic-evaluation-v1: ${message}`)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    fail(`${label} has an invalid schema`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`)
  return value
}

function parse(input: unknown): EvaluationInput {
  const root = object(input, 'input')
  exactKeys(root, ['provenance', 'rows'], 'input')
  if (!Array.isArray(root.rows) || root.rows.length === 0) fail('rows must be a non-empty array')
  const provenance = object(root.provenance, 'provenance')
  exactKeys(
    provenance,
    [
      'frozenTestPartitionHash',
      'preprocessingFitSplit',
      'preprocessingTrainingPartitionHash',
      'protocolHash',
      'testFrozen',
      'thresholdSelectionSplit',
      'thresholdValidationPartitionHash',
    ],
    'provenance',
  )
  if (
    provenance.preprocessingFitSplit !== 'train' ||
    provenance.thresholdSelectionSplit !== 'validation' ||
    provenance.testFrozen !== true
  )
    fail('provenance does not satisfy the frozen split protocol')
  for (const key of [
    'preprocessingTrainingPartitionHash',
    'thresholdValidationPartitionHash',
    'frozenTestPartitionHash',
    'protocolHash',
  ]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(text(provenance[key], `provenance.${key}`)))
      fail(`provenance.${key} must be a sha256 hash`)
  }

  const ids = new Set<string>()
  const observations = new Set<string>()
  const rows = root.rows.map((raw, index) => {
    const row = object(raw, `rows[${index}]`)
    exactKeys(
      row,
      ['duplicateGroupId', 'eye', 'id', 'label', 'patientId', 'score', 'split', 'visitId'],
      `rows[${index}]`,
    )
    const parsed: EvaluationRow = {
      id: text(row.id, `rows[${index}].id`),
      patientId: text(row.patientId, `rows[${index}].patientId`),
      eye: row.eye === 'L' || row.eye === 'R' ? row.eye : fail(`rows[${index}].eye must be L or R`),
      visitId: text(row.visitId, `rows[${index}].visitId`),
      duplicateGroupId: text(row.duplicateGroupId, `rows[${index}].duplicateGroupId`),
      split: SPLITS.includes(row.split as EvaluationRow['split'])
        ? (row.split as EvaluationRow['split'])
        : fail(`rows[${index}].split is invalid`),
      label:
        row.label === 0 || row.label === 1
          ? row.label
          : fail(`rows[${index}].label must be 0 or 1`),
      score:
        typeof row.score === 'number' &&
        Number.isFinite(row.score) &&
        row.score >= 0 &&
        row.score <= 1
          ? row.score
          : fail(`rows[${index}].score must be finite and within [0,1]`),
    }
    if (ids.has(parsed.id)) fail(`duplicate observation id ${parsed.id}`)
    ids.add(parsed.id)
    const observation = `${parsed.patientId}\u0000${parsed.eye}\u0000${parsed.visitId}`
    if (observations.has(observation)) fail('patient-eye-visit observation is not unique')
    observations.add(observation)
    return parsed
  })
  for (const key of ['patientId', 'duplicateGroupId'] as const) {
    const seen = new Map<string, EvaluationRow['split']>()
    for (const row of rows) {
      const prior = seen.get(row[key])
      if (prior && prior !== row.split) fail(`${key} crosses splits`)
      seen.set(row[key], row.split)
    }
  }
  const eyes = new Map<string, EvaluationRow['split']>()
  for (const row of rows) {
    const key = `${row.patientId}\u0000${row.eye}`
    const prior = eyes.get(key)
    if (prior && prior !== row.split) fail('patient-eye crosses splits')
    eyes.set(key, row.split)
  }
  if (!rows.some((row) => row.split === 'train')) fail('train split is empty')
  const validation = rows.filter((row) => row.split === 'validation')
  if (!validation.some((row) => row.label === 0) || !validation.some((row) => row.label === 1))
    fail('validation must contain both classes for threshold selection')
  if (!rows.some((row) => row.split === 'test')) fail('test split is empty')
  if (provenance.protocolHash !== sha256(EVALUATION_PROTOCOL))
    fail('provenance protocolHash does not match fixed protocol')
  if (provenance.preprocessingTrainingPartitionHash !== partitionHash(rows, 'train'))
    fail('provenance preprocessingTrainingPartitionHash does not match train rows')
  if (provenance.thresholdValidationPartitionHash !== partitionHash(rows, 'validation'))
    fail('provenance thresholdValidationPartitionHash does not match validation rows')
  if (provenance.frozenTestPartitionHash !== partitionHash(rows, 'test'))
    fail('provenance frozenTestPartitionHash does not match test rows')
  return { rows, provenance: provenance as EvaluationInput['provenance'] }
}

function classified(rows: readonly EvaluationRow[], threshold: number) {
  let tp = 0
  let tn = 0
  let fp = 0
  let fn = 0
  for (const row of rows) {
    if (row.score >= threshold) row.label ? tp++ : fp++
    else row.label ? fn++ : tn++
  }
  return { tp, tn, fp, fn }
}

function value(rows: readonly EvaluationRow[], threshold: number, metric: MetricName): MetricValue {
  const { tp, tn, fp, fn } = classified(rows, threshold)
  if (metric === 'sensitivity')
    return tp + fn ? { value: tp / (tp + fn) } : { value: null, reason: 'single_class_test' }
  if (metric === 'specificity')
    return tn + fp ? { value: tn / (tn + fp) } : { value: null, reason: 'single_class_test' }
  if (metric === 'accuracy') return { value: (tp + tn) / rows.length }
  const positives = rows.filter((row) => row.label === 1)
  const negatives = rows.filter((row) => row.label === 0)
  if (!positives.length || !negatives.length) return { value: null, reason: 'single_class_test' }
  let wins = 0
  for (const positive of positives)
    for (const negative of negatives) {
      wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0
    }
  return { value: wins / (positives.length * negatives.length) }
}

function threshold(rows: readonly EvaluationRow[]) {
  const candidates = [...new Set([0, ...rows.map((row) => row.score), 1 + Number.EPSILON])].sort(
    (a, b) => a - b,
  )
  let best = { value: candidates[0]!, youdenJ: -Infinity }
  for (const candidate of candidates) {
    const sensitivity = value(rows, candidate, 'sensitivity').value!
    const specificity = value(rows, candidate, 'specificity').value!
    const youdenJ = sensitivity + specificity - 1
    if (youdenJ > best.youdenJ) best = { value: candidate, youdenJ }
  }
  return best
}

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function interval(
  rows: readonly EvaluationRow[],
  thresholdValue: number,
  metric: MetricName,
): BootstrapInterval {
  const byPatient = new Map<string, EvaluationRow[]>()
  for (const row of rows) {
    const group = byPatient.get(row.patientId) ?? []
    group.push(row)
    byPatient.set(row.patientId, group)
  }
  const groups = [...byPatient.values()]
  const next = random(EVALUATION_PROTOCOL.bootstrap.seed)
  const samples: number[] = []
  for (let rep = 0; rep < EVALUATION_PROTOCOL.bootstrap.repetitions; rep++) {
    const sample = Array.from(
      { length: groups.length },
      () => groups[Math.floor(next() * groups.length)]!,
    ).flat()
    const metricValue = value(sample, thresholdValue, metric).value
    if (metricValue !== null) samples.push(metricValue)
  }
  const minimum = Math.ceil(
    EVALUATION_PROTOCOL.bootstrap.repetitions * EVALUATION_PROTOCOL.bootstrap.minEffectiveRatio,
  )
  if (samples.length < minimum)
    return {
      lower: null,
      upper: null,
      effectiveRepetitions: samples.length,
      reason: 'insufficient_valid_bootstrap_replicates',
    }
  samples.sort((a, b) => a - b)
  return {
    lower: samples[Math.floor((samples.length - 1) * 0.025)]!,
    upper: samples[Math.ceil((samples.length - 1) * 0.975)]!,
    effectiveRepetitions: samples.length,
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex')}`
}

function partitionHash(rows: readonly EvaluationRow[], split: EvaluationRow['split']): string {
  return sha256(
    rows
      .filter((row) => row.split === split)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  )
}

export function evaluateSynthetic(input: unknown): EvaluationReport {
  const parsed = parse(input)
  const validation = parsed.rows.filter((row) => row.split === 'validation')
  const test = parsed.rows.filter((row) => row.split === 'test')
  const selected = threshold(validation)
  const metrics = Object.fromEntries(
    METRICS.map((metric) => [metric, value(test, selected.value, metric)]),
  ) as EvaluationReport['metrics']
  const confidenceIntervals = Object.fromEntries(
    METRICS.map((metric) => [metric, interval(test, selected.value, metric)]),
  ) as EvaluationReport['confidenceIntervals']
  const groupCounts = Object.fromEntries(
    SPLITS.map((split) => {
      const rows = parsed.rows.filter((row) => row.split === split)
      return [
        split,
        {
          observations: rows.length,
          patients: new Set(rows.map((row) => row.patientId)).size,
          patientEyes: new Set(rows.map((row) => `${row.patientId}\u0000${row.eye}`)).size,
          duplicateGroups: new Set(rows.map((row) => row.duplicateGroupId)).size,
        },
      ]
    }),
  ) as EvaluationReport['groupCounts']
  return {
    protocol: EVALUATION_PROTOCOL,
    threshold: { value: selected.value, selectionSplit: 'validation', youdenJ: selected.youdenJ },
    metrics,
    confusion: (() => {
      const counts = classified(test, selected.value)
      return {
        truePositive: counts.tp,
        trueNegative: counts.tn,
        falsePositive: counts.fp,
        falseNegative: counts.fn,
      }
    })(),
    confidenceIntervals,
    bootstrap: EVALUATION_PROTOCOL.bootstrap,
    groupCounts,
    method: {
      scoreRange: '[0,1]',
      testEvaluation: 'threshold_fixed_from_validation',
      bootstrapUnit: 'patient',
    },
    provenanceHashes: {
      rowsSha256: sha256(parsed.rows),
      provenanceSha256: sha256(parsed.provenance),
      protocolSha256: sha256(EVALUATION_PROTOCOL),
      preprocessingTrainingPartitionSha256: partitionHash(parsed.rows, 'train'),
      thresholdValidationPartitionSha256: partitionHash(parsed.rows, 'validation'),
      frozenTestPartitionSha256: partitionHash(parsed.rows, 'test'),
    },
  }
}
