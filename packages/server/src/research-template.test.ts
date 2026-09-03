import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTeamConfig } from '@qywork/runtime'
import { scanSkills } from '@qywork/tools'
import { ensureResearchWorkspace } from './research-template.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oph-research-template-'))
  roots.push(root)
  return root
}

describe('眼科科研工作区模板', () => {
  test('初始化出四个技能、四个职责角色与研究目录', async () => {
    const root = await tempWorkspace()
    const result = ensureResearchWorkspace(root)

    expect(result.created).toHaveLength(6)
    expect((await scanSkills(root)).map((skill) => skill.name).sort()).toEqual([
      'oph-research-pipeline',
      'oph-results-review',
      'ssh-data-audit',
      'ssh-experiment-runner',
    ])

    const team = await loadTeamConfig(root)
    expect(team.error).toBeNull()
    expect(team.roles.map((role) => role.id)).toEqual([
      'coordinator',
      'data-auditor',
      'experimenter',
      'independent-reviewer',
    ])
    expect(
      team.roles.every((role) => role.provider === undefined && role.model === undefined),
    ).toBe(true)
    expect(await readFile(join(root, 'research', 'README.md'), 'utf8')).toContain('原始影像')
  })

  test('重复初始化不覆盖用户已经修改的角色配置', async () => {
    const root = await tempWorkspace()
    ensureResearchWorkspace(root)
    const teamPath = join(root, '.qy', 'team.json')
    await writeFile(teamPath, '{"roles":[],"custom":true}\n', 'utf8')

    const result = ensureResearchWorkspace(root)

    expect(result.created).toEqual([])
    expect(result.existing).toHaveLength(6)
    expect(await readFile(teamPath, 'utf8')).toBe('{"roles":[],"custom":true}\n')
  })

  test('仓库自带的科研配置与新工作区模板保持一致', async () => {
    const root = await tempWorkspace()
    const result = ensureResearchWorkspace(root)
    const repositoryRoot = resolve(import.meta.dir, '../../..')

    for (const relativePath of result.created) {
      expect(await readFile(join(repositoryRoot, relativePath), 'utf8')).toBe(
        await readFile(join(root, relativePath), 'utf8'),
      )
    }
  })
})
