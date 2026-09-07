import {
  isResearchTemplateId,
  type ResearchTaskRevision,
  type ResearchTemplateId,
  type SyntheticCompletionValidation,
} from '@oph-autoresearch/core'
import fixture from '../../../../fixtures/synthetic-summary.json'
import {
  assertEvaluationSkill,
  EVALUATION_SKILL_BINDING,
  evaluationOutput,
  reviewEvaluationEvidence,
} from './evaluation-template.ts'
import {
  assertRetinalSkill,
  RETINAL_SKILL_BINDING,
  retinalEvaluationOutput,
  reviewRetinalEvidence,
} from './retinal-template.ts'
import { verifyTrackedTemplate } from './runner-tracking.ts'
import { sha256 } from './skill-lock.ts'
import {
  executeSupervisedExperiment,
  SUPERVISED_BINDING,
  SUPERVISED_INPUT_HASH,
  verifySupervisedExperiment,
} from './supervised-experiment.ts'
import { reviewSyntheticEvidence } from './synthetic-review.ts'
import { assertFirstPartySyntheticSkill, SYNTHETIC_SKILL_BINDING } from './synthetic-skill.ts'
import { executeSyntheticTemplate } from './synthetic-template.ts'
import {
  assertTrainingSkill,
  reviewTrainingEvidence,
  TRAINING_SKILL_BINDING,
  trainingEvaluationOutput,
} from './training-template.ts'

export interface FixedResearchTemplate {
  id: ResearchTemplateId
  filename:
    | 'summary.json'
    | 'evaluation.json'
    | 'training-evaluation.json'
    | 'retinal-evaluation.json'
    | 'supervised-experiment.json'
  binding: NonNullable<ResearchTaskRevision['skillBinding']>
  assertSkill(manifest?: unknown): Promise<void>
  execute(): { schema: ResearchTemplateId; inputHash: string }
  inputHash?(): string
  verify(bytes: Uint8Array): SyntheticCompletionValidation
  reviewKind: string
}
function summaryOutput() {
  if (
    fixture.schema !== 'synthetic-summary-v1' ||
    !fixture.input.modality ||
    !fixture.input.values.length ||
    !fixture.input.values.every(Number.isFinite) ||
    sha256(JSON.stringify(fixture.input)) !== fixture.inputHash
  )
    throw new Error('Invalid fixed summary source')
  return {
    schema: 'synthetic-summary-v1' as const,
    inputHash: fixture.inputHash,
    statistics: executeSyntheticTemplate(fixture.input.values),
  }
}
/** Single server dispatch table; API, runner, receipt and daemon consumers use these same plans. */
const plans: Record<ResearchTemplateId, FixedResearchTemplate> = {
  'supervised-phantom-v2': {
    id: 'supervised-phantom-v2',
    filename: 'supervised-experiment.json',
    binding: SUPERVISED_BINDING,
    async assertSkill() {},
    inputHash: () => SUPERVISED_INPUT_HASH,
    execute: executeSupervisedExperiment,
    verify: verifySupervisedExperiment,
    reviewKind: 'independent-training-and-metric-recomputation',
  },
  'synthetic-retinal-image-v1': {
    id: 'synthetic-retinal-image-v1',
    filename: 'retinal-evaluation.json',
    binding: RETINAL_SKILL_BINDING,
    assertSkill: assertRetinalSkill,
    execute: retinalEvaluationOutput,
    verify: reviewRetinalEvidence,
    reviewKind: 'fixed-contract-recomputation',
  },
  'synthetic-summary-v1': {
    id: 'synthetic-summary-v1',
    filename: 'summary.json',
    binding: SYNTHETIC_SKILL_BINDING,
    assertSkill: assertFirstPartySyntheticSkill,
    execute: summaryOutput,
    verify: reviewSyntheticEvidence,
    reviewKind: 'independent-machine',
  },
  'synthetic-evaluation-v1': {
    id: 'synthetic-evaluation-v1',
    filename: 'evaluation.json',
    binding: EVALUATION_SKILL_BINDING,
    assertSkill: assertEvaluationSkill,
    execute: evaluationOutput,
    verify: reviewEvaluationEvidence,
    reviewKind: 'fixed-contract-recomputation',
  },
  'synthetic-training-evaluation-v1': {
    id: 'synthetic-training-evaluation-v1',
    filename: 'training-evaluation.json',
    binding: TRAINING_SKILL_BINDING,
    assertSkill: assertTrainingSkill,
    execute: trainingEvaluationOutput,
    verify: reviewTrainingEvidence,
    reviewKind: 'fixed-contract-recomputation',
  },
}
for (const plan of Object.values(plans)) {
  const base = plan.verify
  plan.verify = (bytes) => verifyTrackedTemplate(base, bytes)
  Object.freeze(plan)
}
Object.freeze(plans)
export function fixedResearchTemplate(id: unknown = 'synthetic-summary-v1'): FixedResearchTemplate {
  if (!isResearchTemplateId(id)) throw new Error('Unknown fixed research template')
  return plans[id]
}

export function researchTemplateCatalog() {
  return Object.values(plans).map((plan) => ({
    id: plan.id,
    inputHash: plan.inputHash?.() ?? plan.execute().inputHash,
    codeHash: plan.binding.sourceHash,
    requiresDaemon: plan.id === 'supervised-phantom-v2',
  }))
}
