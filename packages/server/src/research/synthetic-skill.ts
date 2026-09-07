import fixture from '../../../../fixtures/synthetic-summary.json'
import {
  canonicalJson,
  type SkillLock,
  type SourceSnapshot,
  sha256,
  verifySkillLock,
} from './skill-lock.ts'
import { lockedResearchSkillPort } from './skill-port.ts'
import { SYNTHETIC_TEMPLATE_HASH } from './synthetic-template.ts'

const FIXTURE_HASH = 'sha256:18407351ce14deebb94e1453cd885bed521ef6767085cf91a6e097bbee25d07e'

/** The exact summary shape evaluated by the fixed local runner; its hash is stored in the lock. */
export const FIRST_PARTY_SYNTHETIC_EVALUATION_CONTRACT = Object.freeze({
  schema: 'synthetic-summary-v1',
  inputHash: 'sha256:43e5f2a62bb17464cf45a9f8f0f00ed73922843690f24262fa3ae031ef4b1e49',
  statistics: Object.freeze({ count: 8, mean: 39.375, min: 12, max: 73 }),
})

export interface FirstPartySyntheticSkillManifest extends SkillLock {
  id: 'oph-first-party-synthetic-summary'
  version: 1
  source: Readonly<SourceSnapshot>
}

/**
 * The only approved synthetic skill source. Its repository metadata is provenance evidence; the
 * canonical content hash is the executable trust check in bundled and source-tree deployments.
 */
export const FIRST_PARTY_SYNTHETIC_SKILL: Readonly<FirstPartySyntheticSkillManifest> =
  Object.freeze({
    id: 'oph-first-party-synthetic-summary',
    version: 1,
    source: Object.freeze({
      sourceKind: 'local-bundle',
      // The fixture was added in this working tree, so this base commit is only release context.
      baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
      path: 'fixtures/synthetic-summary.json',
      contentHash: FIXTURE_HASH,
      license: 'MIT',
      dependencies: Object.freeze([]) as readonly string[],
      scriptHash: 'sha256:9112240c8fda849bf079677983f1733791ef49c596afc7249940ada1185df6c7',
      tools: Object.freeze([]) as readonly string[],
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
    }),
  })

/** Rejects every manifest except the locked first-party source and its bundle-contained bytes. */
export const SYNTHETIC_SKILL_BINDING = Object.freeze({
  id: FIRST_PARTY_SYNTHETIC_SKILL.id,
  version: FIRST_PARTY_SYNTHETIC_SKILL.version,
  sourceHash: FIRST_PARTY_SYNTHETIC_SKILL.source.contentHash,
  evaluationHash: FIRST_PARTY_SYNTHETIC_SKILL.source.evaluation.hash,
  templateId: 'synthetic-summary-v1',
  templateHash: SYNTHETIC_TEMPLATE_HASH,
})

export function verifyFirstPartySyntheticSkill(manifest: unknown): boolean {
  if (
    sha256(canonicalJson(FIRST_PARTY_SYNTHETIC_EVALUATION_CONTRACT)) !==
    FIRST_PARTY_SYNTHETIC_SKILL.source.evaluation.hash
  )
    return false
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const candidate = manifest as Partial<FirstPartySyntheticSkillManifest>
  const keys = Object.keys(candidate).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== 'id' ||
    keys[1] !== 'source' ||
    keys[2] !== 'version' ||
    candidate.id !== FIRST_PARTY_SYNTHETIC_SKILL.id ||
    candidate.version !== FIRST_PARTY_SYNTHETIC_SKILL.version
  ) {
    return false
  }
  return verifySkillLock(FIRST_PARTY_SYNTHETIC_SKILL, candidate.source, canonicalJson(fixture)).ok
}

/**
 * Reads no external source: the runner may proceed only when its bundle-contained fixture and
 * complete fixed provenance snapshot match. Candidate manifests remain inert verification input.
 */
export async function assertFirstPartySyntheticSkill(
  manifest: unknown = FIRST_PARTY_SYNTHETIC_SKILL,
): Promise<void> {
  if (!verifyFirstPartySyntheticSkill(manifest)) {
    throw new Error('固定合成技能清单无效')
  }
  const port = lockedResearchSkillPort([
    {
      lock: FIRST_PARTY_SYNTHETIC_SKILL,
      observe: async () => ({
        snapshot: (manifest as FirstPartySyntheticSkillManifest).source,
        content: canonicalJson(fixture),
      }),
    },
  ])
  await port.read(FIRST_PARTY_SYNTHETIC_SKILL.id)
}
