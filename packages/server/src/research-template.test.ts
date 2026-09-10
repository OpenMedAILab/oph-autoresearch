import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTeamConfig } from '@oph-autoresearch/runtime'
import { scanSkills } from '@oph-autoresearch/tools'
import { ensureResearchWorkspace } from './research-template.ts'

const roots: string[] = []

/** 模板早期版本写出的 skill 原文，用于验证未改动文件会被升级。 */
const LEGACY_STUDY_PROTOCOL_SKILL = `---
name: oph-study-protocol
description: 为眼科影像与 AI 研究冻结方案和统计分析计划；用于患者级拆分、样本量、终点、亚组、基线、消融、停止规则和实验规格。
---

# 眼科 AI 研究方案与统计设计

## 冻结项

- 纳入/排除标准、索引日期、标签来源和裁决流程。
- 患者级最小隔离单位；双眼、纵向检查、近重复图像和中心泄漏规则。
- 主要/次要指标、阈值选择、95% 置信区间、缺失值和多重比较处理。
- 预设亚组、外部测试、基线、消融、校准、公平性和失败判据。
- 样本量或精度目标、随机种子、资源预算、停止规则和偏离方案的记录方式。

## 输出与闸门

生成 \`research/study_protocol.md\` 与 \`research/experiment_spec.yaml\`。关键字段存在待定值、数据快照不明确或统计效能不足时，不得进入训练；列出需要研究者决定的最小问题，并创建人工检查点。
`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oph-research-template-'))
  roots.push(root)
  return root
}

describe('眼科科研工作区模板', () => {
  test('SSH permissions migrate only when omitted and independent roles retain their marker', async () => {
    const root = await tempWorkspace()
    ensureResearchWorkspace(root)
    const path = join(root, '.oph/team.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    delete config.roles.find((role: { id: string }) => role.id === 'experiment-engineer')
      .allowedTools
    config.roles.find((role: { id: string }) => role.id === 'data-auditor').allowedTools = []
    await writeFile(path, JSON.stringify(config))
    ensureResearchWorkspace(root)
    const roles = (await loadTeamConfig(root)).roles
    expect(roles.find((role) => role.id === 'experiment-engineer')?.allowedTools).toContain(
      'ssh_job_status',
    )
    expect(roles.find((role) => role.id === 'data-auditor')?.allowedTools).toEqual([])
    expect(roles.filter((role) => role.independence === 'required')).toHaveLength(6)
  })
  test('未改动的旧 skill 与旧工具面随模板升级，改过的保持原样', async () => {
    const root = await tempWorkspace()
    ensureResearchWorkspace(root)
    const skillPath = join(root, '.agents/skills/oph-study-protocol/SKILL.md')
    await writeFile(skillPath, LEGACY_STUDY_PROTOCOL_SKILL)
    const customPath = join(root, '.agents/skills/oph-question-design/SKILL.md')
    await writeFile(customPath, '---\nname: oph-question-design\ndescription: 我改过\n---\n')
    const teamPath = join(root, '.oph/team.json')
    const config = JSON.parse(await readFile(teamPath, 'utf8'))
    const auditor = config.roles.find(
      (role: { id: string }) => role.id === 'reproducibility-auditor',
    )
    auditor.allowedTools = ['read_skill', 'read_file', 'list_dir', 'glob', 'grep', 'run_command']
    const preparer = config.roles.find((role: { id: string }) => role.id === 'experiment-preparer')
    preparer.allowedTools = ['read_file']
    await writeFile(teamPath, JSON.stringify(config))

    const result = ensureResearchWorkspace(root)

    expect(result.updated).toEqual(['.agents/skills/oph-study-protocol/SKILL.md', '.oph/team.json'])
    expect(await readFile(skillPath, 'utf8')).toContain('报告指南对照')
    expect(await readFile(customPath, 'utf8')).toContain('我改过')
    const roles = (await loadTeamConfig(root)).roles
    expect(roles.find((role) => role.id === 'reproducibility-auditor')?.allowedTools).toContain(
      'ssh_read_file',
    )
    expect(roles.find((role) => role.id === 'experiment-preparer')?.allowedTools).toEqual([
      'read_file',
    ])
  })

  test('初始化出六阶段技能、职责角色与研究目录', async () => {
    const root = await tempWorkspace()
    const result = ensureResearchWorkspace(root)

    expect(result.created).toHaveLength(15)
    expect(result.updated).toEqual([])
    expect((await scanSkills(root)).map((skill) => skill.name).sort()).toEqual([
      'oph-experiment-iteration',
      'oph-manuscript-format',
      'oph-manuscript-review',
      'oph-question-design',
      'oph-research-pipeline',
      'oph-research-reporting',
      'oph-results-review',
      'oph-study-protocol',
      'oph-venue-analysis',
      'oph-writing-style',
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
      'results-analyst',
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
    expect(await Bun.file(join(root, 'research', 'OPEN_SOURCE_STACK.md')).exists()).toBe(false)
    expect(await Bun.file(join(root, '.oph/patterns.json')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'research/artifact_ledger.yaml')).exists()).toBe(false)
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
    expect(migrated.templateVersion).toBe(5)
    expect(migrated.roles).toHaveLength(15)
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
      if (relativePath === '.oph/team.json') {
        expect(JSON.parse(repository)).toEqual(JSON.parse(generated))
      } else {
        expect(repository).toBe(generated)
      }
    }
  })
})

test('retired empty ledger is removed on upgrade while customized files are preserved', async () => {
  const root = await tempWorkspace()
  ensureResearchWorkspace(root)
  const ledger = join(root, 'research/artifact_ledger.yaml')
  await writeFile(
    ledger,
    'schema_version: 1\nartifacts: []\n# 每条记录至少包含：artifact_id, stage, path, source, data_snapshot,\n# code_revision, config_hash, run_id, verification, created_at。\n',
  )
  const patterns = join(root, '.oph/patterns.json')
  await writeFile(patterns, '{"custom":true}\n')
  const result = ensureResearchWorkspace(root)
  expect(result.updated).toContain('research/artifact_ledger.yaml')
  expect(await Bun.file(ledger).exists()).toBe(false)
  expect(await readFile(patterns, 'utf8')).toBe('{"custom":true}\n')
  await writeFile(ledger, 'artifacts: [my-run]\n')
  ensureResearchWorkspace(root)
  expect(await readFile(ledger, 'utf8')).toBe('artifacts: [my-run]\n')
})
