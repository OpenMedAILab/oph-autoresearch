import curated from '../../../../fixtures/curated-skill-evaluations.json'
import { canonicalJson, sha256 } from './skill-lock.ts'
import {
  type CapturedSourceCandidate,
  snapshotUnadmittedCandidate,
  verifyCandidateSourceBytes,
} from './source-candidates.ts'

export interface CandidateEvaluation {
  schema: 'static-skill-pre-admission-v1'
  source: {
    repository: string
    commit: string
    path: string
    contentHash: string
    gitBlobHash: string
    byteLength: number
    license: string
  }
  decision: 'rejected-until-reviewed'
  executionEnabled: false
  dependencyClosureReviewed: false
  behaviorEvaluated: false
  findings: Array<{ code: string; line: number | null; lineHash: string | null }>
  reportHash: string
}

const rules = [
  { code: 'declared-tools-not-granted', pattern: /^\s*allowed-tools\s*:/i },
  { code: 'external-credential-required', pattern: /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN)\b/ },
  {
    code: 'dependency-install-not-reviewed',
    pattern: /\b(?:pip\s+install|npm\s+install|bun\s+add|uv\s+add)\b/i,
  },
  { code: 'remote-shell-pipeline-not-reviewed', pattern: /\b(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/i },
  { code: 'referenced-script-not-reviewed', pattern: /\bscripts\/[a-zA-Z0-9_./-]+/ },
  {
    code: 'referenced-support-file-not-reviewed',
    pattern: /\b(?:assets|references)\/[a-zA-Z0-9_./-]+/,
  },
] as const

/** Static pre-admission checks, not execution or a behavioral security evaluation.
 * Missing lexical findings never admit a source: the unreviewed dependency closure
 * always keeps the candidate inert. No path/URL from the source is opened.
 */
export function evaluateSkillCandidate(
  manifest: CapturedSourceCandidate,
  bytes: Uint8Array,
): CandidateEvaluation {
  const snapshot = snapshotUnadmittedCandidate(manifest)
  if (!snapshot || bytes.byteLength > 256_000 || !verifyCandidateSourceBytes(snapshot, bytes).ok)
    throw new Error('Candidate source bytes are not pinned and verified')
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/)
  if (lines.length > 20_000) throw new Error('Candidate source has too many lines')
  const findings: CandidateEvaluation['findings'] = [
    { code: 'dependency-closure-unreviewed', line: null, lineHash: null },
  ]
  for (const [index, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line))
        findings.push({ code: rule.code, line: index + 1, lineHash: sha256(line) })
      if (findings.length > 256) throw new Error('Candidate exceeds bounded static assessment')
    }
  }
  const report = {
    schema: 'static-skill-pre-admission-v1' as const,
    source: {
      repository: manifest.originRepo,
      commit: manifest.commitSHA,
      path: manifest.skillPath,
      contentHash: manifest.contentHash,
      gitBlobHash: manifest.gitBlobSHA,
      byteLength: manifest.byteLength,
      license: manifest.license,
    },
    decision: 'rejected-until-reviewed' as const,
    executionEnabled: false as const,
    dependencyClosureReviewed: false as const,
    behaviorEvaluated: false as const,
    findings,
  }
  return { ...report, reportHash: sha256(canonicalJson(report)) }
}

/** Captured report data only. This list never grants registry/Runner admission. */
export function curatedSkillEvaluations(): CandidateEvaluation[] {
  const expectedHashes = [
    'sha256:84296e32bd1aedd79bda26f318c876c30779a8af9038c8b39bea222b5553d427',
    'sha256:e8795c48253ea9f36612b995393834f989e16e7a5f7f151806d9324046622f9d',
    'sha256:27f838f7acea52a1711bdbb483bce505f930e4478d14c96e05a6d9e232e50133',
  ]
  if (curated.length !== expectedHashes.length) throw new Error('Curated static assessment drift')
  for (const [index, item] of curated.entries()) {
    const { reportHash, ...report } = item
    if (
      reportHash !== expectedHashes[index] ||
      reportHash !== sha256(canonicalJson(report)) ||
      report.executionEnabled !== false ||
      report.behaviorEvaluated !== false ||
      report.decision !== 'rejected-until-reviewed'
    )
      throw new Error('Curated static assessment drift')
  }
  return structuredClone(curated) as CandidateEvaluation[]
}
