import type { SyntheticCompletionValidation } from '@oph-autoresearch/core'
import fixture from '../../../../fixtures/synthetic-features.json'
import { EVALUATION_PROTOCOL, type EvaluationRow, evaluateSynthetic } from './evaluation.ts'
import { canonicalJson, type SkillLock, sha256 } from './skill-lock.ts'
import { lockedResearchSkillPort } from './skill-port.ts'

export const TRAINING_PROTOCOL = Object.freeze({
  id: 'synthetic-training-evaluation-v1',
  preprocessing: 'subtract_training_mean',
  scoring: 'fixed_logistic_no_classifier_fit',
  evaluation: EVALUATION_PROTOCOL,
})
type FeatureRow = Omit<EvaluationRow, 'score'> & { feature: number }

/** Only training features contribute to the fitted parameter. Labels never enter this fixed scorer. */
export function fitAndEvaluate(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid feature fixture')
  const data = input as { schema: string; rows: FeatureRow[] }
  if (
    Object.keys(data).sort().join(',') !== 'rows,schema' ||
    data.schema !== 'synthetic-features-v1' ||
    !Array.isArray(data.rows)
  )
    throw new Error('Invalid feature schema')
  for (const row of data.rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).sort().join(',') !==
        'duplicateGroupId,eye,feature,id,label,patientId,split,visitId' ||
      !Number.isFinite(row.feature) ||
      Math.abs(row.feature) > 100
    )
      throw new Error('Invalid synthetic feature')
  }
  const training = data.rows
    .filter((row) => row.split === 'train')
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!training.length) throw new Error('No training features')
  const mean = training.reduce((sum, row) => sum + row.feature, 0) / training.length
  const parameters = { mean }
  const rows = data.rows.map(({ feature, ...row }) => ({
    ...row,
    score: 1 / (1 + Math.exp(-(feature - mean))),
  }))
  const partition = (split: string) =>
    sha256(
      canonicalJson(
        rows.filter((row) => row.split === split).toSorted((a, b) => a.id.localeCompare(b.id)),
      ),
    )
  const report = evaluateSynthetic({
    rows,
    provenance: {
      preprocessingFitSplit: 'train',
      thresholdSelectionSplit: 'validation',
      testFrozen: true,
      preprocessingTrainingPartitionHash: partition('train'),
      thresholdValidationPartitionHash: partition('validation'),
      frozenTestPartitionHash: partition('test'),
      protocolHash: sha256(canonicalJson(EVALUATION_PROTOCOL)),
    },
  })
  return {
    report,
    preprocessing: {
      algorithm: TRAINING_PROTOCOL.preprocessing,
      fitSplit: 'train',
      trainingObservations: training.length,
      trainingFeaturesHash: sha256(canonicalJson(training)),
      parameters,
      parametersHash: sha256(canonicalJson(parameters)),
      scoring: TRAINING_PROTOCOL.scoring,
    },
  }
}

const FIXTURE_HASH = 'sha256:dd7967fbd9025be0a1699371aca7449c3b977ec4f1fe620894cfc7b1932cebd2'
const PROTOCOL_HASH = 'sha256:d48fa4c868942455296e896885454b7d2790e9823f10118d2ce7083a86996030'
const REPORT_HASH = 'sha256:fb41d7e19f6dc42677cba1888d51f59ed5dae849943e4efb4a60d76c5b6663ba'
export const TRAINING_SKILL: SkillLock = {
  id: 'oph-first-party-synthetic-training-evaluation',
  version: 1,
  source: {
    sourceKind: 'local-bundle',
    baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
    path: 'fixtures/synthetic-features.json',
    contentHash: FIXTURE_HASH,
    license: 'MIT',
    dependencies: [],
    scriptHash: PROTOCOL_HASH,
    tools: [],
    network: 'deny',
    data: 'synthetic-only',
    backend: 'builtin-local',
    evaluation: { id: 'synthetic-training-evaluation-contract-v1', hash: REPORT_HASH },
    reviewer: 'code-owned-first-party-lock',
    status: 'admitted-first-party',
    executionEnabled: true,
  },
}
export const TRAINING_SKILL_BINDING = Object.freeze({
  id: TRAINING_SKILL.id,
  version: 1,
  sourceHash: FIXTURE_HASH,
  evaluationHash: REPORT_HASH,
  templateId: 'synthetic-training-evaluation-v1',
  templateHash: PROTOCOL_HASH,
})
export function trainingEvaluationOutput() {
  if (
    sha256(canonicalJson(fixture)) !== FIXTURE_HASH ||
    sha256(canonicalJson(TRAINING_PROTOCOL)) !== PROTOCOL_HASH
  )
    throw new Error('Fixed training source or descriptor drift')
  const result = fitAndEvaluate(fixture)
  if (sha256(canonicalJson(result)) !== REPORT_HASH)
    throw new Error('Fixed training evaluation contract drift')
  return { schema: 'synthetic-training-evaluation-v1' as const, inputHash: FIXTURE_HASH, ...result }
}
export async function assertTrainingSkill(manifest: unknown = TRAINING_SKILL) {
  if (canonicalJson(manifest) !== canonicalJson(TRAINING_SKILL))
    throw new Error('Invalid fixed training skill')
  trainingEvaluationOutput()
  await lockedResearchSkillPort([
    {
      lock: TRAINING_SKILL,
      observe: async () => ({ snapshot: TRAINING_SKILL.source, content: canonicalJson(fixture) }),
    },
  ]).read(TRAINING_SKILL.id)
}
export function reviewTrainingEvidence(bytes: Uint8Array): SyntheticCompletionValidation {
  if (bytes.byteLength > 64 * 1024) throw new Error('Training evidence exceeds size limit')
  if (
    canonicalJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !==
    canonicalJson(trainingEvaluationOutput())
  )
    throw new Error('Training evidence differs from recomputed contract')
  return {
    inputHash: FIXTURE_HASH,
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength,
    verifiedAt: Date.now(),
  }
}
