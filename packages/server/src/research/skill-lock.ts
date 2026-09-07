/**
 * A code-owned record of the only source a research consumer may use.
 *
 * Candidate metadata is intentionally inert data. Verification never imports a package, runs an
 * evaluator, opens a repository, or follows a network URL; consumers must opt in to a fixed lock.
 */

interface SourceSnapshotCommon {
  sourceKind: 'local-bundle' | 'git-pinned'
  path: string
  contentHash: string
  license: string
  dependencies: readonly string[]
  scriptHash: string
  tools: readonly string[]
  network: 'deny'
  data: string
  backend: string
  evaluation: { id: string; hash: string }
  reviewer: string
  status: 'admitted-first-party' | 'candidate-not-admitted'
  executionEnabled: boolean
}

/** A local source is embedded in the build; baseCommit is context, never proof that it contained it. */
export interface LocalBundleSourceSnapshot extends SourceSnapshotCommon {
  sourceKind: 'local-bundle'
  baseCommit: string
}

/** A third-party source names an immutable Git object as part of its provenance. */
export interface GitPinnedSourceSnapshot extends SourceSnapshotCommon {
  sourceKind: 'git-pinned'
  repository: string
  commit: string
}

export type SourceSnapshot = LocalBundleSourceSnapshot | GitPinnedSourceSnapshot

export interface SkillLock {
  id: string
  version: number
  source: Readonly<SourceSnapshot>
}

export type SkillLockVerification =
  | { ok: true }
  | {
      ok: false
      code: 'invalid_snapshot' | 'snapshot_drift' | 'source_hash_mismatch'
      message: string
    }

const SHA256 = /^sha256:[a-f0-9]{64}$/

/** A deterministic byte representation, independent of source-file whitespace and JSON key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return `sha256:${hasher.digest('hex')}`
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Validates the complete provenance declaration before comparing it to a code-owned lock. */
export function isSourceSnapshot(value: unknown): value is SourceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  if (snapshot.sourceKind !== 'local-bundle' && snapshot.sourceKind !== 'git-pinned') return false
  if (
    !/^[a-f0-9]{40}$/.test(
      String(snapshot.sourceKind === 'local-bundle' ? snapshot.baseCommit : snapshot.commit),
    )
  )
    return false
  const commonKeys = [
    'sourceKind',
    'path',
    'contentHash',
    'license',
    'dependencies',
    'scriptHash',
    'tools',
    'network',
    'data',
    'backend',
    'evaluation',
    'reviewer',
    'status',
    'executionEnabled',
  ]
  const provenanceKeys =
    snapshot.sourceKind === 'local-bundle'
      ? ['baseCommit']
      : snapshot.sourceKind === 'git-pinned'
        ? ['repository', 'commit']
        : []
  if (
    !hasExactKeys(snapshot, [...commonKeys, ...provenanceKeys]) ||
    !['path', 'license', 'data', 'backend', 'reviewer'].every(
      (key) => typeof snapshot[key] === 'string' && snapshot[key].length > 0,
    ) ||
    (snapshot.sourceKind === 'local-bundle' &&
      (typeof snapshot.baseCommit !== 'string' || snapshot.baseCommit.length === 0)) ||
    (snapshot.sourceKind === 'git-pinned' &&
      !['repository', 'commit'].every(
        (key) => typeof snapshot[key] === 'string' && snapshot[key].length > 0,
      )) ||
    !SHA256.test(String(snapshot.contentHash)) ||
    !Array.isArray(snapshot.dependencies) ||
    !snapshot.dependencies.every((dependency) => typeof dependency === 'string') ||
    !SHA256.test(String(snapshot.scriptHash)) ||
    !Array.isArray(snapshot.tools) ||
    !snapshot.tools.every((tool) => typeof tool === 'string') ||
    snapshot.network !== 'deny' ||
    typeof snapshot.reviewer !== 'string' ||
    !['admitted-first-party', 'candidate-not-admitted'].includes(String(snapshot.status)) ||
    typeof snapshot.executionEnabled !== 'boolean' ||
    !snapshot.evaluation ||
    typeof snapshot.evaluation !== 'object' ||
    Array.isArray(snapshot.evaluation)
  ) {
    return false
  }
  const evaluation = snapshot.evaluation as Record<string, unknown>
  return (
    hasExactKeys(evaluation, ['id', 'hash']) &&
    typeof evaluation.id === 'string' &&
    evaluation.id.length > 0 &&
    typeof evaluation.hash === 'string' &&
    SHA256.test(evaluation.hash)
  )
}

/**
 * Read-only candidate review. A matching declaration and bytes are necessary before a caller may
 * use a source, but this function never turns a candidate into an active skill.
 */
export function verifySkillLock(
  lock: Readonly<SkillLock>,
  candidate: unknown,
  source: string | Uint8Array,
): SkillLockVerification {
  if (!isSourceSnapshot(lock.source) || !isSourceSnapshot(candidate)) {
    return { ok: false, code: 'invalid_snapshot', message: '技能来源快照无效' }
  }
  if (lock.source.status !== 'admitted-first-party' || !lock.source.executionEnabled) {
    return { ok: false, code: 'invalid_snapshot', message: '技能来源未获执行准入' }
  }
  if (canonicalJson(candidate) !== canonicalJson(lock.source)) {
    return { ok: false, code: 'snapshot_drift', message: '技能来源快照发生漂移' }
  }
  if (sha256(source) !== lock.source.contentHash) {
    return { ok: false, code: 'source_hash_mismatch', message: '技能来源内容哈希不一致' }
  }
  return { ok: true }
}
