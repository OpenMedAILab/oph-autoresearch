/** Coverage: the actual read_skill tool consumes locked research content without workspace fallback. */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolContext } from '@oph-autoresearch/agent'
import { DEFAULT_DENSITY } from '@oph-autoresearch/ai'
import fixture from '../../../../fixtures/synthetic-summary.json'
import { readSkillTool } from '../../../tools/src/skills.ts'
import { canonicalJson } from './skill-lock.ts'
import { lockedResearchSkillPort } from './skill-port.ts'
import { FIRST_PARTY_SYNTHETIC_SKILL } from './synthetic-skill.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function context(
  workspaceRoot: string,
  researchSkills: NonNullable<ToolContext['researchSkills']>,
): ToolContext {
  return {
    workspaceRoot,
    researchSkills,
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

describe('locked research read_skill port', () => {
  test('reads the captured approved content once, then denies byte or snapshot drift without workspace fallback', async () => {
    const tempRoot = join(resolve(import.meta.dir, '../../../..'), '.tmp')
    await mkdir(tempRoot, { recursive: true })
    const workspaceRoot = await mkdtemp(join(tempRoot, 'skill-port-'))
    roots.push(workspaceRoot)
    const workspaceCanary = 'workspace-skill-body-must-not-leak'
    await mkdir(join(workspaceRoot, '.agents', 'skills', 'candidate'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.agents', 'skills', 'candidate', 'SKILL.md'),
      `---\nname: candidate\ndescription: fallback canary\n---\n${workspaceCanary}`,
      'utf8',
    )

    const approvedContent = canonicalJson(fixture)
    let observedSnapshot: unknown = FIRST_PARTY_SYNTHETIC_SKILL.source
    let observedContent = approvedContent
    const researchSkills = lockedResearchSkillPort([
      {
        lock: FIRST_PARTY_SYNTHETIC_SKILL,
        observe: async () => ({ snapshot: observedSnapshot, content: observedContent }),
      },
    ])
    const ctx = context(workspaceRoot, researchSkills)

    const first = await readSkillTool.fn({ name: FIRST_PARTY_SYNTHETIC_SKILL.id }, ctx)
    expect(first).toMatchObject({
      status: 'success',
      message: approvedContent,
      data: { name: FIRST_PARTY_SYNTHETIC_SKILL.id, source: 'research-lock' },
    })

    observedSnapshot = { ...FIRST_PARTY_SYNTHETIC_SKILL.source, license: 'unknown' }
    const snapshotDrift = await readSkillTool.fn({ name: FIRST_PARTY_SYNTHETIC_SKILL.id }, ctx)
    expect(snapshotDrift).toMatchObject({
      status: 'failure',
      message: '研究技能未准入或已发生漂移',
    })
    expect(snapshotDrift.message).not.toContain(workspaceCanary)

    observedSnapshot = FIRST_PARTY_SYNTHETIC_SKILL.source
    observedContent = `${approvedContent} `
    const byteDrift = await readSkillTool.fn({ name: FIRST_PARTY_SYNTHETIC_SKILL.id }, ctx)
    expect(byteDrift).toMatchObject({ status: 'failure', message: '研究技能未准入或已发生漂移' })
    expect(byteDrift.message).not.toContain(approvedContent)

    for (const name of ['candidate', 'unknown-skill']) {
      const denied = await readSkillTool.fn({ name }, ctx)
      expect(denied).toMatchObject({ status: 'failure', message: '研究技能未准入或已发生漂移' })
      expect(denied.message).not.toContain(workspaceCanary)
    }
  })
})
