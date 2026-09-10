#!/usr/bin/env bun
/** Explicit paid discovery sample; isolated workspace, existing workflow/store, human scoring only. */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type OphConfig } from '@oph-autoresearch/runtime'
import {
  appendStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createResearchCampaign,
  createRun,
  finishRun,
  markRunRunning,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from '../packages/server/src/bus.ts'
import { makeDelegate } from '../packages/server/src/delegate.ts'
import { campaignUsage } from '../packages/server/src/research/campaign-usage.ts'
import { researchPreset } from '../packages/server/src/research/research-assistant.ts'
import { ensureResearchWorkspace } from '../packages/server/src/research-template.ts'
import { RunManager } from '../packages/server/src/runs.ts'
import { workflowTool } from '../packages/tools/src/workflow.ts'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
export async function runDiscoverySmoke(input: {
  config: OphConfig
  goal: string
  root: string
  report: string
  signal: AbortSignal
}) {
  await mkdir(input.root, { recursive: true })
  ensureResearchWorkspace(input.root)
  // Evaluate the currently edited skills, not only the bundled defaults.
  await cp(join(REPO, '.agents', 'skills'), join(input.root, '.agents', 'skills'), {
    recursive: true,
  })
  await cp(join(REPO, '.oph', 'team.json'), join(input.root, '.oph', 'team.json'))
  const skillHashes: Record<string, string> = {}
  for (const skill of await readdir(join(input.root, '.agents', 'skills'))) {
    const bytes = await readFile(join(input.root, '.agents', 'skills', skill, 'SKILL.md'))
    skillHashes[skill] = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  }
  const path = join(input.root, 'smoke.sqlite'),
    store = new Store({ path }),
    content = new ContentStore(contentPathFor(path))
  try {
    const workspace = upsertWorkspace(store, input.root, 'Discovery smoke')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: input.config.active.provider,
      model: input.config.active.model,
    })
    const created = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: input.goal,
      idempotencyKey: 'smoke',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
    })
    if (!created.ok) throw new Error(created.message)
    const bus = new EventBus(),
      runs = new RunManager(store, bus)
    const deps = {
      store,
      config: input.config,
      workspaceRoot: input.root,
      workspaceId: workspace.id,
      bus,
      runs,
    }
    const preset = await researchPreset(deps, created.campaign, 'discovery')
    const run = createRun(store, {
      conversationId: parent.id,
      workspaceId: workspace.id,
      model: input.config.active.model,
      clientRequestId: 'discovery',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'running',
      payload: { kind: 'tool_call', args: preset.workflow },
    })
    const delegate = makeDelegate({
      workspaceRoot: input.root,
      conversationId: parent.id,
      deps: { ...deps, content },
    })
    const outcome = await workflowTool.fn(preset.workflow, {
      delegate,
      runId: run.id,
      stepId: step.id,
      signal: input.signal,
    } as unknown as Parameters<typeof workflowTool.fn>[1])
    settleToolStep(store, step.id, outcome.status === 'success' ? 'success' : 'failure', {
      kind: 'tool_result',
      args: preset.workflow,
      outcome: { ...outcome, executed: outcome.executed ?? outcome.data?.workflowId === step.id },
    })
    finishRun(store, run.id, {
      status: outcome.status === 'success' ? 'done' : 'failed',
      stopReason: outcome.status === 'success' ? 'completed' : 'internal_guard',
    })
    const result = {
      provider: input.config.active.provider,
      model: input.config.active.model,
      goal: input.goal,
      skillHashes,
      workflow: preset.workflow,
      outcome,
      usage: campaignUsage(store, parent.id),
    }
    await writeFile(join(input.root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    await mkdir(resolve(input.report, '..'), { recursive: true })
    await writeFile(
      input.report,
      `# Discovery 人工抽样\n\n- 日期：${new Date().toISOString()}\n- 模型：${result.provider} / ${result.model}\n- 主题：${input.goal}\n- 工作流状态：${String(outcome.data?.phase ?? outcome.status)}\n- 回执与 skill 哈希：${join(input.root, 'result.json')}\n- 用量：${JSON.stringify(result.usage)}\n- 科学质量：待人工评分（工作流完成不代表证据通过）\n\n| 项目 | 分数 0–2 | 证据 / 问题定位 |\n|---|---|---|\n| 引用可核实 | 待评 | |\n| 反证与替代方案 | 待评 | |\n| 阅读深度与写法边界 | 待评 | |\n| 冻结方案与统计设计 | 待评 | |\n| 字段与来源完整性 | 待评 | |\n\n0=错误或缺失，1=部分满足，2=满足且有定位证据。记录修订 skill 后的独立抽样，不能把离线 fixture 当成真实表现。\n`,
    )
    return result
  } finally {
    store.close()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes('--run')) {
    console.log(
      '未发起模型请求。真实抽样：bun run scripts/smoke-research-discovery.ts --run --provider <已配置接口> --model <已配置模型> --goal <公开研究主题>\n执行 discovery 一轮并停在核验检查点；使用已配置模型（含独立审查接口），会产生 API 费用。结果在 .tmp/research-discovery，人工评分表在 docs/plans。',
    )
  } else {
    if (!args.includes('--provider') || !args.includes('--model') || !args.includes('--goal'))
      throw new Error('必须显式指定 provider、model 和 goal')
    const config = await loadConfig(),
      provider = value('--provider')!,
      model = value('--model')!,
      goal = value('--goal')!
    if (
      !goal?.trim() ||
      !config.providers[provider]?.apiKey?.trim() ||
      !config.providers[provider]?.models[model]
    )
      throw new Error('接口凭证、模型或主题未配置')
    config.active = { provider, model }
    const stamp = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`
    const result = await runDiscoverySmoke({
      config,
      goal,
      root: join(REPO, '.tmp', 'research-discovery', stamp),
      report: join(REPO, 'docs', 'plans', `${stamp}-discovery-score.md`),
      signal: AbortSignal.timeout(15 * 60_000),
    })
    console.log(
      `Discovery: ${String(result.outcome.data?.phase ?? result.outcome.status)}；人工评分表：docs/plans/${stamp}-discovery-score.md`,
    )
    if (result.outcome.status !== 'success') process.exitCode = 1
  }
}
