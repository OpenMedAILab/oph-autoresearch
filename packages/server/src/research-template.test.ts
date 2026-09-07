import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTeamConfig } from '@oph-autoresearch/runtime'
import { scanSkills } from '@oph-autoresearch/tools'
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
  test('初始化出六阶段技能、职责角色与研究目录', async () => {
    const root = await tempWorkspace()
    const result = ensureResearchWorkspace(root)

    expect(result.created).toHaveLength(15)
    expect(result.updated).toEqual([])
    expect((await scanSkills(root)).map((skill) => skill.name).sort()).toEqual([
      'oph-manuscript-review',
      'oph-question-design',
      'oph-research-pipeline',
      'oph-research-reporting',
      'oph-results-review',
      'oph-study-protocol',
      'oph-venue-analysis',
      'ssh-data-audit',
      'ssh-experiment-runner',
    ])

    const team = await loadTeamConfig(root)
    expect(team.error).toBeNull()
    expect(team.roles.map((role) => role.id)).toEqual([
      'coordinator',
      'research-questioner',
      'data-auditor',
      'protocol-statistician',
      'experiment-engineer',
      'independent-reviewer',
      'evidence-writer',
      'clinical-challenger',
      'methodology-critic',
      'reproducibility-auditor',
      'venue-analyst',
      'experiment-preparer',
      'manuscript-reviewer',
    ])
    expect(
      team.roles.every((role) => role.provider === undefined && role.model === undefined),
    ).toBe(true)
    expect(team.roles.every((role) => role.modules?.length && role.skills?.length)).toBe(true)
    expect(await readFile(join(root, 'research', 'README.md'), 'utf8')).toContain('原始影像')
    expect(await readFile(join(root, 'research', 'OPEN_SOURCE_STACK.md'), 'utf8')).toContain(
      'OpenJiuwen',
    )
  })

  test('旧配置保留自定义字段，并只补缺失角色、模块和技能', async () => {
    const root = await tempWorkspace()
    ensureResearchWorkspace(root)
    const teamPath = join(root, '.oph', 'team.json')
    await writeFile(
      teamPath,
      `${JSON.stringify({
        name: '我的科研团队',
        custom: true,
        roles: [
          {
            id: 'coordinator',
            name: '自定义协调员',
            systemPrompt: '保留我的提示词',
            model: 'deepseek-chat',
          },
          { id: 'custom-role', name: '自定义角色', modules: ['自定义模块'], skills: [] },
        ],
      })}\n`,
      'utf8',
    )

    const result = ensureResearchWorkspace(root)

    expect(result.created).toEqual([])
    expect(result.existing).toHaveLength(15)
    expect(result.updated).toEqual(['.oph/team.json'])
    const migrated = JSON.parse(await readFile(teamPath, 'utf8'))
    expect(migrated.name).toBe('我的科研团队')
    expect(migrated.custom).toBe(true)
    expect(migrated.templateVersion).toBe(4)
    expect(migrated.roles).toHaveLength(14)
    expect(migrated.roles[0]).toMatchObject({
      id: 'coordinator',
      name: '自定义协调员',
      systemPrompt: '保留我的提示词',
      model: 'deepseek-chat',
    })
    expect(migrated.roles[0].modules.length).toBeGreaterThan(0)
    expect(migrated.roles[0].skills).toEqual(['oph-research-pipeline'])
    expect(migrated.roles[1]).toEqual({
      id: 'custom-role',
      name: '自定义角色',
      modules: ['自定义模块'],
      skills: [],
    })
  })

  test('仓库自带的科研配置与新工作区模板保持一致', async () => {
    const root = await tempWorkspace()
    const result = ensureResearchWorkspace(root)
    const repositoryRoot = resolve(import.meta.dir, '../../..')

    for (const relativePath of result.created) {
      const repository = await readFile(join(repositoryRoot, relativePath), 'utf8')
      const generated = await readFile(join(root, relativePath), 'utf8')
      if (relativePath === '.oph/team.json' || relativePath === '.oph/patterns.json') {
        expect(JSON.parse(repository)).toEqual(JSON.parse(generated))
      } else {
        expect(repository).toBe(generated)
      }
    }
  })
})
