import { describe, expect, test } from 'bun:test'
import {
  canonicalJson,
  isSourceSnapshot,
  type SkillLock,
  sha256,
  verifySkillLock,
} from './skill-lock.ts'

const source = { name: 'fixed synthetic source', values: [12, 18] }
const snapshot = {
  sourceKind: 'local-bundle' as const,
  baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
  path: 'fixtures/synthetic-summary.json',
  contentHash: sha256(canonicalJson(source)),
  license: 'MIT',
  dependencies: [],
  scriptHash: sha256('no-scripts'),
  tools: [],
  network: 'deny' as const,
  data: 'synthetic-only',
  backend: 'builtin-local',
  evaluation: { id: 'synthetic-summary-contract-v1', hash: sha256('fixed-evaluation') },
  reviewer: 'code-owned-fixture',
  status: 'admitted-first-party' as const,
  executionEnabled: true,
}
const lock: SkillLock = { id: 'fixed-source', version: 1, source: snapshot }

describe('skill source lock', () => {
  test('rejects unsupported source kinds and non-pinned revisions', () => {
    const { baseCommit: _, ...common } = snapshot
    expect(isSourceSnapshot({ ...common, sourceKind: 'unsupported' })).toBe(false)
    expect(
      isSourceSnapshot({
        ...common,
        sourceKind: 'git-pinned',
        repository: 'https://example.com/source',
        commit: 'main',
      }),
    ).toBe(false)
  })
  test('accepts only the fixed full snapshot and exact source bytes', () => {
    expect(verifySkillLock(lock, snapshot, canonicalJson(source))).toEqual({ ok: true })
  })

  test('reviews third-party candidates as data and rejects provenance or byte drift', () => {
    expect(
      verifySkillLock(lock, { ...snapshot, baseCommit: 'deadbeef' }, canonicalJson(source)),
    ).toMatchObject({ ok: false, code: 'invalid_snapshot' })
    expect(
      verifySkillLock(lock, snapshot, canonicalJson({ ...source, values: [99] })),
    ).toMatchObject({
      ok: false,
      code: 'source_hash_mismatch',
    })
    expect(
      verifySkillLock(lock, { ...snapshot, network: 'allow' }, canonicalJson(source)),
    ).toMatchObject({
      ok: false,
      code: 'invalid_snapshot',
    })
  })
})
