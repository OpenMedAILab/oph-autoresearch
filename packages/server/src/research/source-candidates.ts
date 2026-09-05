import {
  type GitPinnedSourceSnapshot,
  isSourceSnapshot,
  type SkillLockVerification,
  sha256,
} from './skill-lock.ts'

export interface CapturedSourceCandidate {
  originRepo: string
  commitSHA: string
  skillPath: string
  gitBlobSHA: string
  contentHash: string
  byteLength: number
  license: string
  status: 'candidate-not-admitted'
  executionEnabled: false
  dependenciesReviewed: false
}

export interface CandidateSourceSnapshot {
  source: Readonly<GitPinnedSourceSnapshot>
  gitBlobHash: string
  byteLength: number
  dependenciesReviewed: false
}

const SHA1 = /^[a-f0-9]{40}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const NO_SCRIPTS_HASH = 'sha256:9112240c8fda849bf079677983f1733791ef49c596afc7249940ada1185df6c7'
const NOT_EVALUATED_HASH = 'sha256:6658fcc5c3be589b3966dc48ee9c307ed5962dd7b0a0a5df4c111f0b57548a93'

function isCapturedCandidate(value: unknown): value is CapturedSourceCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    ['originRepo', 'commitSHA', 'skillPath', 'gitBlobSHA', 'contentHash', 'license'].every(
      (key) => typeof candidate[key] === 'string' && candidate[key].length > 0,
    ) &&
    SHA1.test(String(candidate.gitBlobSHA)) &&
    SHA1.test(String(candidate.commitSHA)) &&
    SHA256.test(String(candidate.contentHash)) &&
    Number.isSafeInteger(candidate.byteLength) &&
    (candidate.byteLength as number) >= 0 &&
    candidate.status === 'candidate-not-admitted' &&
    candidate.executionEnabled === false &&
    candidate.dependenciesReviewed === false
  )
}

/**
 * Maps a captured external candidate into inert provenance data. Its own frontmatter never grants
 * Bash, network, model, or dependency permissions: all effective capabilities remain empty/denied.
 */
export function snapshotUnadmittedCandidate(value: unknown): CandidateSourceSnapshot | null {
  if (!isCapturedCandidate(value)) return null
  return {
    source: {
      sourceKind: 'git-pinned',
      repository: value.originRepo,
      commit: value.commitSHA,
      path: value.skillPath,
      contentHash: value.contentHash,
      license: value.license,
      dependencies: [],
      scriptHash: NO_SCRIPTS_HASH,
      tools: [],
      network: 'deny',
      data: 'public-text-only',
      backend: 'none',
      evaluation: { id: 'not-evaluated', hash: NOT_EVALUATED_HASH },
      reviewer: 'unreviewed-candidate',
      status: 'candidate-not-admitted',
      executionEnabled: false,
    },
    gitBlobHash: value.gitBlobSHA,
    byteLength: value.byteLength,
    dependenciesReviewed: false,
  }
}

/** Checks only captured bytes and declared immutable metadata; it cannot activate the candidate. */
export function verifyCandidateSourceBytes(
  candidate: CandidateSourceSnapshot,
  bytes: Uint8Array,
): SkillLockVerification {
  if (
    !isSourceSnapshot(candidate.source) ||
    candidate.source.status !== 'candidate-not-admitted' ||
    candidate.source.executionEnabled ||
    candidate.source.tools.length > 0 ||
    candidate.source.network !== 'deny' ||
    candidate.source.backend !== 'none' ||
    candidate.dependenciesReviewed ||
    bytes.byteLength !== candidate.byteLength
  ) {
    return { ok: false, code: 'invalid_snapshot', message: '候选技能不满足只读验证条件' }
  }
  if (sha256(bytes) !== candidate.source.contentHash) {
    return { ok: false, code: 'source_hash_mismatch', message: '候选技能来源内容哈希不一致' }
  }
  const blob = new Bun.CryptoHasher('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex')
  if (blob !== candidate.gitBlobHash)
    return { ok: false, code: 'source_hash_mismatch', message: '候选Git blob哈希不一致' }
  return { ok: true }
}
