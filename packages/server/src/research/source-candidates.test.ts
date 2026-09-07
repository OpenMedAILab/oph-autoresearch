import { describe, expect, test } from 'bun:test'
import { verifySkillLock } from './skill-lock.ts'
import { snapshotUnadmittedCandidate, verifyCandidateSourceBytes } from './source-candidates.ts'

// This is an inert excerpt-shaped fixture, not an installed copy of an external skill.
const candidateText = `---
name: literature-review
allowed-tools: Read Write Edit Bash
metadata:
  openclaw:
    primaryEnv: OPENROUTER_API_KEY
---

Candidate text only; it must not grant any capability.
`
const candidateBytes = new TextEncoder().encode(candidateText)
const candidateManifest = {
  originRepo: 'https://github.com/K-Dense-AI/scientific-agent-skills',
  commitSHA: '1e5eeffbdad3749125afe7ab48a39694e27f181c',
  skillPath: 'skills/literature-review/SKILL.md',
  gitBlobSHA: new Bun.CryptoHasher('sha1')
    .update(`blob ${candidateBytes.byteLength}\0`)
    .update(candidateBytes)
    .digest('hex'),
  contentHash: 'sha256:4b209315f49484a60a84d32aa51b2f72a3830a8f348080e677f50ef54edd8413',
  byteLength: 181,
  license: 'MIT',
  status: 'candidate-not-admitted' as const,
  executionEnabled: false as const,
  dependenciesReviewed: false as const,
}

describe('unadmitted external skill source snapshots', () => {
  test('rejects unpinned commits and mismatched Git object identity', () => {
    expect(snapshotUnadmittedCandidate({ ...candidateManifest, commitSHA: 'main' })).toBeNull()
    const candidate = snapshotUnadmittedCandidate({
      ...candidateManifest,
      gitBlobSHA: 'a'.repeat(40),
    })!
    expect(verifyCandidateSourceBytes(candidate, candidateBytes)).toMatchObject({
      ok: false,
      code: 'source_hash_mismatch',
    })
  })
  test('maps a pinned candidate as data without activating its declared Bash/OpenRouter behavior', () => {
    const candidate = snapshotUnadmittedCandidate(candidateManifest)
    expect(candidate).not.toBeNull()
    if (!candidate) return

    expect(verifyCandidateSourceBytes(candidate, candidateBytes)).toEqual({ ok: true })
    expect(candidate.source).toMatchObject({
      sourceKind: 'git-pinned',
      repository: 'https://github.com/K-Dense-AI/scientific-agent-skills',
      commit: '1e5eeffbdad3749125afe7ab48a39694e27f181c',
      path: 'skills/literature-review/SKILL.md',
      license: 'MIT',
      tools: [],
      network: 'deny',
      backend: 'none',
      status: 'candidate-not-admitted',
      executionEnabled: false,
    })
    expect(candidateText).toContain('OPENROUTER_API_KEY')
    expect(candidate.source.tools).toEqual([])
    expect(candidate.source.network).toBe('deny')
    expect(
      verifySkillLock(
        { id: 'candidate', version: 1, source: candidate.source },
        candidate.source,
        candidateBytes,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_snapshot' })
  })

  test('rejects a candidate whose captured bytes drift from its pinned hash', () => {
    const candidate = snapshotUnadmittedCandidate(candidateManifest)
    expect(candidate).not.toBeNull()
    if (!candidate) return
    expect(
      verifyCandidateSourceBytes(
        candidate,
        new TextEncoder().encode(candidateText.replace('capability.', 'capabilitY.')),
      ),
    ).toMatchObject({ ok: false, code: 'source_hash_mismatch' })
  })
})
