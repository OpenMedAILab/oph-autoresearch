import type { SyntheticCompletionValidation } from '@oph-autoresearch/core'
import fixture from '../../../../fixtures/synthetic-evaluation.json'
import { EVALUATION_PROTOCOL, evaluateSynthetic } from './evaluation.ts'
import { canonicalJson, type SkillLock, sha256 } from './skill-lock.ts'
import { lockedResearchSkillPort } from './skill-port.ts'

// Pins describe bundled synthetic data and the fixed algorithm protocol, not a trained model.
const FIXTURE_HASH = 'sha256:9b09a08398f284d650b86d71dba7d9b5b3a5f2183e90d57b327ec1d4efebf237'
const PROTOCOL_HASH = 'sha256:27a6b6661bce87e4a7d0e58c0d9ea2d5878e348c22e24f9829bbe8a219df63f9'
const REPORT_HASH = 'sha256:28b85761f4194f1fdd1c536a6f444cba60b8b67a0af151cabeb190bf386599f3'

export const EVALUATION_SKILL: SkillLock = {
  id: 'oph-first-party-synthetic-evaluation',
  version: 1,
  source: {
    sourceKind: 'local-bundle',
    baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
    path: 'fixtures/synthetic-evaluation.json',
    contentHash: FIXTURE_HASH,
    license: 'MIT',
    dependencies: [],
    scriptHash: PROTOCOL_HASH,
    tools: [],
    network: 'deny',
    data: 'synthetic-only',
    backend: 'builtin-local',
    evaluation: { id: 'synthetic-evaluation-report-v1', hash: REPORT_HASH },
    reviewer: 'code-owned-first-party-lock',
    status: 'admitted-first-party',
    executionEnabled: true,
  },
}
export const EVALUATION_SKILL_BINDING = Object.freeze({
  id: EVALUATION_SKILL.id,
  version: 1,
  sourceHash: FIXTURE_HASH,
  evaluationHash: REPORT_HASH,
  templateId: 'synthetic-evaluation-v1',
  templateHash: PROTOCOL_HASH,
})
export function evaluationOutput() {
  if (
    sha256(canonicalJson(fixture)) !== FIXTURE_HASH ||
    sha256(canonicalJson(EVALUATION_PROTOCOL)) !== PROTOCOL_HASH
  )
    throw new Error('Fixed evaluation source or protocol drift')
  const report = evaluateSynthetic(fixture)
  if (sha256(canonicalJson(report)) !== REPORT_HASH)
    throw new Error('Fixed evaluation contract drift')
  return { schema: 'synthetic-evaluation-v1' as const, inputHash: FIXTURE_HASH, report }
}
export async function assertEvaluationSkill(manifest: unknown = EVALUATION_SKILL) {
  if (canonicalJson(manifest) !== canonicalJson(EVALUATION_SKILL))
    throw new Error('Invalid fixed evaluation skill')
  evaluationOutput()
  await lockedResearchSkillPort([
    {
      lock: EVALUATION_SKILL,
      observe: async () => ({ snapshot: EVALUATION_SKILL.source, content: canonicalJson(fixture) }),
    },
  ]).read(EVALUATION_SKILL.id)
}

/** Rereads bytes and recomputes the fixed contract; this is not a separate statistical implementation. */
export function reviewEvaluationEvidence(bytes: Uint8Array): SyntheticCompletionValidation {
  if (bytes.byteLength > 64 * 1024) throw new Error('Evaluation evidence exceeds size limit')
  const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const expected = evaluationOutput()
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error('Evaluation evidence differs from recomputed contract')
  return {
    inputHash: FIXTURE_HASH,
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength,
    verifiedAt: Date.now(),
  }
}
