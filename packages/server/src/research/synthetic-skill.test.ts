/** Coverage: synthetic-skill.ts first-party source, license, and zero-capability lock. */

import { describe, expect, test } from 'bun:test'
import { canonicalJson, sha256 } from './skill-lock.ts'
import {
  assertFirstPartySyntheticSkill,
  FIRST_PARTY_SYNTHETIC_EVALUATION_CONTRACT,
  FIRST_PARTY_SYNTHETIC_SKILL,
  verifyFirstPartySyntheticSkill,
} from './synthetic-skill.ts'

describe('first-party synthetic skill lock', () => {
  test('records the checked-in source, hash, license, and no execution capabilities', async () => {
    expect(FIRST_PARTY_SYNTHETIC_SKILL).toEqual({
      id: 'oph-first-party-synthetic-summary',
      version: 1,
      source: {
        sourceKind: 'local-bundle',
        baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
        path: 'fixtures/synthetic-summary.json',
        contentHash: 'sha256:18407351ce14deebb94e1453cd885bed521ef6767085cf91a6e097bbee25d07e',
        license: 'MIT',
        dependencies: [],
        scriptHash: 'sha256:9112240c8fda849bf079677983f1733791ef49c596afc7249940ada1185df6c7',
        tools: [],
        network: 'deny',
        data: 'synthetic-only',
        backend: 'builtin-local',
        evaluation: {
          id: 'synthetic-summary-contract-v1',
          hash: 'sha256:d50c7ed65371e13d16d17844be062cc769732c6e2004ea8c8eb4a01fbe96a20f',
        },
        reviewer: 'code-owned-first-party-lock',
        status: 'admitted-first-party',
        executionEnabled: true,
      },
    })
    expect(verifyFirstPartySyntheticSkill(FIRST_PARTY_SYNTHETIC_SKILL)).toBe(true)
    expect(sha256(canonicalJson(FIRST_PARTY_SYNTHETIC_EVALUATION_CONTRACT))).toBe(
      FIRST_PARTY_SYNTHETIC_SKILL.source.evaluation.hash,
    )
    await expect(assertFirstPartySyntheticSkill()).resolves.toBeUndefined()
  })

  test('rejects changed provenance, license, or permissions', async () => {
    for (const altered of [
      {
        ...FIRST_PARTY_SYNTHETIC_SKILL,
        source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, contentHash: 'sha256:deadbeef' },
      },
      {
        ...FIRST_PARTY_SYNTHETIC_SKILL,
        source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, license: 'unknown' },
      },
      {
        ...FIRST_PARTY_SYNTHETIC_SKILL,
        source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, tools: ['shell'] },
      },
      {
        ...FIRST_PARTY_SYNTHETIC_SKILL,
        source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, network: 'allow' },
      },
      {
        ...FIRST_PARTY_SYNTHETIC_SKILL,
        source: { ...FIRST_PARTY_SYNTHETIC_SKILL.source, backend: 'remote-clinical' },
      },
      { ...FIRST_PARTY_SYNTHETIC_SKILL, claimedBy: 'third-party' },
    ]) {
      expect(verifyFirstPartySyntheticSkill(altered)).toBe(false)
      await expect(assertFirstPartySyntheticSkill(altered)).rejects.toThrow('固定合成技能清单无效')
    }
  })
})
