import { curatedSkillEvaluations } from './curated-skill-evaluation.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { fixedResearchTemplate } from './template-registry.ts'

type DataMode = 'scores' | 'features' | 'retinal-images' | 'auto'
type Backend = 'builtin-local' | 'localhost-daemon' | 'ssh-daemon'
interface PatternInput {
  dataMode: DataMode
  backend: Backend
  policy: {
    syntheticOnly: true
    allowPublicMetadata: boolean
    maxModelRequests: 2
    currency: 'USD' | 'CNY'
    budget: number
  }
  adaptive?: { minSensitivity: number; minSpecificity: number; maxAuRocCIWidth: number }
}
const candidates: Record<DataMode, readonly string[]> = {
  auto: [
    'synthetic-evaluation-v1',
    'synthetic-training-evaluation-v1',
    'synthetic-retinal-image-v1',
  ],
  scores: ['synthetic-evaluation-v1'],
  features: ['synthetic-training-evaluation-v1'],
  'retinal-images': ['synthetic-retinal-image-v1'],
}
const stages = [
  'question',
  'literature',
  'dataset_audit',
  'protocol_freeze',
  'smoke',
  'experiment',
  'evaluation',
  'independent_review',
  'release',
] as const
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function parse(input: unknown): PatternInput {
  if (
    !record(input) ||
    !exact(
      input,
      ['adaptive', 'backend', 'dataMode', 'policy'].filter((k) => k in input),
    ) ||
    !record(input.policy) ||
    !exact(input.policy, [
      'allowPublicMetadata',
      'budget',
      'currency',
      'maxModelRequests',
      'syntheticOnly',
    ])
  )
    throw new Error('Invalid research Pattern schema')
  const { dataMode, backend } = input
  const policy = input.policy as Record<string, unknown>
  const adaptive = input.adaptive as Record<string, unknown> | undefined
  const budget = policy.budget
  const minSensitivity = adaptive?.minSensitivity
  const minSpecificity = adaptive?.minSpecificity
  const maxAuRocCIWidth = adaptive?.maxAuRocCIWidth
  if (
    !['scores', 'features', 'retinal-images', 'auto'].includes(String(dataMode)) ||
    !['builtin-local', 'localhost-daemon', 'ssh-daemon'].includes(String(backend)) ||
    policy.syntheticOnly !== true ||
    typeof policy.allowPublicMetadata !== 'boolean' ||
    policy.maxModelRequests !== 2 ||
    !['USD', 'CNY'].includes(String(policy.currency)) ||
    !finite(budget) ||
    budget < 0
  )
    throw new Error('Invalid research Pattern policy')
  if (
    adaptive !== undefined &&
    (!record(adaptive) ||
      !exact(adaptive, ['maxAuRocCIWidth', 'minSensitivity', 'minSpecificity']) ||
      !finite(minSensitivity) ||
      !finite(minSpecificity) ||
      !finite(maxAuRocCIWidth) ||
      minSensitivity < 0 ||
      minSensitivity > 1 ||
      minSpecificity < 0 ||
      minSpecificity > 1 ||
      maxAuRocCIWidth < 0)
  )
    throw new Error('Invalid research Pattern adaptive criteria')
  return structuredClone(input) as unknown as PatternInput
}
function measurement(templateId: string) {
  const output = fixedResearchTemplate(templateId).execute() as {
    inputHash: string
    report?: {
      metrics?: {
        sensitivity?: { value: number | null }
        specificity?: { value: number | null }
        auroc?: { value: number | null }
      }
      confidenceIntervals?: { auroc?: { lower: number; upper: number } }
    }
  }
  const report = output.report
  return {
    templateId,
    inputHash: output.inputHash,
    sensitivity: report?.metrics?.sensitivity?.value ?? null,
    specificity: report?.metrics?.specificity?.value ?? null,
    auroc: report?.metrics?.auroc?.value ?? null,
    aurocCIWidth: report?.confidenceIntervals?.auroc
      ? report.confidenceIntervals.auroc.upper - report.confidenceIntervals.auroc.lower
      : null,
  }
}
export function compileResearchPattern(input: unknown) {
  const pattern = parse(input)
  const selectedCandidates = candidates[pattern.dataMode]
  const measurements = selectedCandidates.map(measurement).map((measurement) => ({
    ...measurement,
    reasons: pattern.adaptive
      ? [
          ...(measurement.sensitivity === null ||
          measurement.sensitivity < pattern.adaptive.minSensitivity
            ? ['sensitivity']
            : []),
          ...(measurement.specificity === null ||
          measurement.specificity < pattern.adaptive.minSpecificity
            ? ['specificity']
            : []),
          ...(measurement.aurocCIWidth === null ||
          measurement.aurocCIWidth > pattern.adaptive.maxAuRocCIWidth
            ? ['auroc_ci_width']
            : []),
        ]
      : [],
  }))
  const selected = pattern.adaptive
    ? measurements.find(
        (m) =>
          m.sensitivity !== null &&
          m.specificity !== null &&
          m.aurocCIWidth !== null &&
          m.sensitivity >= pattern.adaptive!.minSensitivity &&
          m.specificity >= pattern.adaptive!.minSpecificity &&
          m.aurocCIWidth <= pattern.adaptive!.maxAuRocCIWidth &&
          m.reasons.length === 0,
      )
    : measurements[0]
  const nodes = stages.map((stageId, index) => ({
    stageId,
    dependsOn: index ? [stages[index - 1]] : [],
    action:
      stageId === 'smoke'
        ? 'synthetic-summary-v1'
        : stageId === 'experiment' || stageId === 'evaluation'
          ? (selected?.templateId ?? 'blocked')
          : 'ledger-only',
    requiresHumanApproval: ['experiment', 'independent_review', 'release'].includes(stageId),
    evidenceContract:
      stageId === 'smoke'
        ? 'synthetic-summary-v1'
        : stageId === 'experiment' || stageId === 'evaluation'
          ? (selected?.templateId ?? 'blocked')
          : 'ledger-fact-v1',
  }))
  const plan = {
    schema: 'research-pattern-v1' as const,
    dataMode: pattern.dataMode,
    backend: pattern.backend,
    policy: pattern.policy,
    candidateAssessments: curatedSkillEvaluations().map((report) => ({
      reportHash: report.reportHash,
      decision: report.decision,
      executionEnabled: report.executionEnabled,
      behaviorEvaluated: report.behaviorEvaluated,
    })),
    measurementBasis: 'fixed-synthetic-fixture-preflight' as const,
    selectionRule: 'first-passing-in-fixed-registry-order' as const,
    applicability:
      'Bundled synthetic fixture checks only; no real-dataset or clinical model ranking' as const,
    nodes,
    selection: {
      selectedTemplateId: selected?.templateId ?? null,
      status: selected ? ('selected' as const) : ('blocked' as const),
      measurements,
      ...(pattern.adaptive ? { criteria: pattern.adaptive } : {}),
    },
  }
  return Object.freeze({ ...plan, contractHash: sha256(canonicalJson(plan)) })
}
