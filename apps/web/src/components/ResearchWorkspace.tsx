import { createMemo, For, Show } from 'solid-js'
import { collapseWorkflowItems } from '../lib/render-items.ts'
import type { TranscriptItem, WorkflowNodeState } from '../lib/store/index.ts'
import {
  isRunning,
  selectedResearchStage,
  setCenterView,
  setSelectedResearchStage,
  transcript,
} from '../lib/store/index.ts'
import { IconCheck, IconChevron, IconShield } from './Icons.tsx'
import { ResearchCampaignPanel } from './ResearchCampaignPanel.tsx'

type StageStatus = 'pending' | 'in_progress' | 'waiting_review' | 'completed' | 'failed'

interface StageDefinition {
  name: string
  detail: string
  agent: string
  role: string
  pattern: string
  team: string
  verification: string
  artifact: string
}

interface StageActivity {
  key: string
  agent: string
  role: string
  task: string
  provider?: string
  model?: string
  phase: string
  result?: string
  error?: string
  durationMs?: number
}

interface ActivityNode {
  id: string
  agent: string
  task: string
  provider?: string
  model?: string
}

const RESEARCH_CHAIN: readonly StageDefinition[] = [
  {
    name: '问题建模',
    detail: '明确临床问题、研究终点、证据缺口与可证伪假设。',
    agent: 'research-questioner',
    role: '研究问题与证据检索员',
    pattern: '候选—反证—综合',
    team: 'Explorer × 2 · 临床反证员 · 综合者',
    verification: '原文定位、可证伪条件与医生确认',
    artifact: 'research/research_question.yaml',
  },
  {
    name: '数据审计',
    detail: '核查队列规模、标签质量、缺失值、偏倚与数据泄漏风险。',
    agent: 'data-auditor',
    role: '数据审计员',
    pattern: '分布式数据审计',
    team: '分区审计 Worker · 泄漏 Challenger · 汇总者',
    verification: '远端真实统计、快照哈希与泄漏检查',
    artifact: 'research/dataset_manifest.json',
  },
  {
    name: '方案冻结',
    detail: '冻结纳排标准、数据拆分、评价指标、统计方法与人工检查点。',
    agent: 'protocol-statistician',
    role: '方案与统计设计员',
    pattern: '候选—批评—冻结',
    team: '临床设计 · 统计设计 · 方法学 Critic',
    verification: '字段完整性、效能分析与人工冻结',
    artifact: 'study_protocol.md · experiment_spec.yaml',
  },
  {
    name: '远程实验',
    detail: '在 SSH 工作区执行基线训练、消融实验、误差分析与运行监控。',
    agent: 'experiment-engineer',
    role: '实验工程师',
    pattern: '远程实验 DAG',
    team: '隔离实验 Worker · 压力测试 Challenger · Auditor',
    verification: '真实命令、日志、退出码、环境与配置哈希',
    artifact: 'research/run_receipt.json',
  },
  {
    name: '独立复核',
    detail: '独立核验统计结论、负结果、敏感性分析与证据追踪关系。',
    agent: 'independent-reviewer',
    role: '独立复核员',
    pattern: '独立自验证',
    team: '独立 Reviewer · 方法学 Critic · 复现 Auditor',
    verification: '新上下文复算、外部验证集与主张—证据映射',
    artifact: 'research/claim_evidence_map.yaml',
  },
  {
    name: '研究输出',
    detail: '整理图表、方法描述、模型卡、研究报告与可复现归档。',
    agent: 'evidence-writer',
    role: '证据写作与报告员',
    pattern: '证据约束文档审查',
    team: 'Writer · 引用核验 · 统计核验 · 综合者',
    verification: '逐句证据定位、引用核验与发布审批',
    artifact: '研究报告 · 模型卡 · 论文草稿',
  },
] as const

function createResearchFlow() {
  const delegated = createMemo(() =>
    collapseWorkflowItems(transcript()).filter(
      (item) => item.toolName === 'workflow' || item.toolName === 'subagent',
    ),
  )
  const workflow = createMemo(() =>
    delegated()
      .filter((item) => item.toolName === 'workflow')
      .at(-1),
  )
  const workflows = createMemo(() => delegated().filter((item) => item.toolName === 'workflow'))
  const directTasks = createMemo(() => delegated().filter((item) => item.toolName === 'subagent'))

  const activities = createMemo(() => {
    const byStage = RESEARCH_CHAIN.map(() => [] as StageActivity[])
    for (const current of workflows()) {
      for (const node of workflowActivityNodes(current)) {
        const stageIndex = stageIndexFor(node.agent, node.task)
        if (stageIndex < 0) continue
        const stage = RESEARCH_CHAIN[stageIndex]!
        const live = current.nodes?.find((entry) => entry.nodeId === node.id)
        const receipt = current.workflow?.results[node.id]
        const durationMs = live?.durationMs ?? receipt?.durationMs
        byStage[stageIndex]!.push({
          key: `${current.id}:${node.id}`,
          agent: node.agent || stage.agent,
          role: live?.label || receipt?.label || stage.role,
          task: node.task,
          ...(node.provider ? { provider: node.provider } : {}),
          ...(node.model ? { model: node.model } : {}),
          phase: live?.phase || receipt?.status || 'pending',
          ...resultFields(live, receipt?.output, receipt?.error),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
      }
    }

    for (const item of directTasks()) {
      const agent = stringValue(item.args?.agent)
      const task = stringValue(item.args?.task)
      const stageIndex = stageIndexFor(agent, task)
      if (stageIndex < 0) continue
      const stage = RESEARCH_CHAIN[stageIndex]!
      const live = item.nodes?.[0]
      const output = stringValue(item.outcome?.data?.output)
      const durationMs = live?.durationMs ?? item.durationMs
      byStage[stageIndex]!.push({
        key: item.id,
        agent: agent || stage.agent,
        role: live?.label || stage.role,
        task: task || '等待主 Agent 分配具体任务',
        ...(stringValue(item.args?.model) ? { model: stringValue(item.args?.model) } : {}),
        phase: live?.phase || settledPhase(item),
        ...resultFields(
          live,
          output,
          item.status === 'failure' ? item.outcome?.message : undefined,
        ),
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
    }

    const waitingStage = checkpointStage(workflow())
    return byStage.map((entries, index) => ({
      entries,
      status:
        waitingStage === index && !entries.some((entry) => entry.phase === 'failed')
          ? ('waiting_review' as const)
          : stageStatus(entries),
    }))
  })

  const completed = createMemo(
    () => activities().filter((stage) => stage.status === 'completed').length,
  )
  const overallStatus = createMemo(() => {
    const current = workflow()?.workflow?.phase
    if (current === 'failed' || activities().some((stage) => stage.status === 'failed'))
      return '执行失败'
    if (current === 'waiting_review') return '等待主会话模型审查'
    if (isRunning() || activities().some((stage) => stage.status === 'in_progress')) return '执行中'
    if (current === 'completed') return '本轮已完成'
    if (delegated().length > 0) return '等待继续'
    return '尚未启动'
  })

  return { workflow, activities, completed, overallStatus }
}

/** 右侧只显示可扫描、可点击的执行链；所有详细内容在中央打开。 */
export function WorkflowOverview() {
  const flow = createResearchFlow()
  return (
    <div class="workflow-overview workflow-overview-compact">
      <div class="workflow-compact-summary">
        <output
          class="workflow-status"
          data-status={flow.workflow()?.workflow?.phase || (isRunning() ? 'running' : 'idle')}
          aria-live="polite"
          aria-atomic="true"
        >
          <span /> {flow.overallStatus()}
        </output>
        <span>
          {flow.completed()} / {RESEARCH_CHAIN.length} 已完成
        </span>
      </div>

      <div
        class="execution-progress"
        role="progressbar"
        aria-label="研究流程完成进度"
        aria-valuemin="0"
        aria-valuemax={RESEARCH_CHAIN.length}
        aria-valuenow={flow.completed()}
      >
        <For each={flow.activities()}>{(stage) => <span data-status={stage.status} />}</For>
      </div>

      <ol class="workflow-nav-list" aria-label="研究执行阶段">
        <For each={RESEARCH_CHAIN}>
          {(stage, index) => {
            const activity = () => flow.activities()[index()]!
            const currentTask = () => activity().entries.at(-1)?.task || stage.role
            return (
              <li data-status={activity().status}>
                <button
                  type="button"
                  classList={{ selected: selectedResearchStage() === index() }}
                  aria-current={selectedResearchStage() === index() ? 'step' : undefined}
                  onClick={() => {
                    setSelectedResearchStage(index())
                    setCenterView('research')
                  }}
                >
                  <span class="execution-step">
                    <Show
                      when={activity().status === 'completed'}
                      fallback={String(index() + 1).padStart(2, '0')}
                    >
                      <IconCheck size={13} />
                    </Show>
                  </span>
                  <span class="workflow-nav-copy">
                    <strong>{stage.name}</strong>
                    <small>{currentTask()}</small>
                  </span>
                  <span class="execution-state">{statusLabel(activity().status)}</span>
                  <IconChevron size={11} dir="right" />
                </button>
              </li>
            )
          }}
        </For>
      </ol>

      <div class="workflow-compact-foot">
        <IconShield size={13} />
        聊天执行视图（未核验）；科研账本在中央详情中查看
      </div>
    </div>
  )
}

/** 从右侧执行链进入的中央阶段详情。 */
export function ResearchStageDetail() {
  const flow = createResearchFlow()
  const index = () => Math.min(RESEARCH_CHAIN.length - 1, Math.max(0, selectedResearchStage()))
  const stage = () => RESEARCH_CHAIN[index()]!
  const activity = () => flow.activities()[index()]!

  return (
    <div class="workspace-view research-stage-view">
      {/* 详情是中央视图的一种，回会话只有「收起」这一条路：右侧执行链点的是换阶段，
          不是离开。收起了还要能再点开，所以选择状态留在 `selectedResearchStage` 上，
          下一次点同一阶段直接回到这里。 */}
      <button class="workspace-back" type="button" onClick={() => setCenterView('chat')}>
        <IconChevron size={12} dir="left" /> 收起详情
      </button>
      <header class="workspace-view-head">
        <div>
          <span class="eyebrow">RESEARCH STAGE {String(index() + 1).padStart(2, '0')}</span>
          <h2>{stage().name}</h2>
          <p>{stage().detail}</p>
        </div>
        <span class="execution-state" data-status={activity().status}>
          {statusLabel(activity().status)}
        </span>
      </header>

      <ResearchCampaignPanel />
      <p>以下为聊天执行记录（legacy_unverified），不代表科研产物已核验或人工批准。</p>
      <section class="research-stage-card" aria-label={`${stage().name}阶段详情`}>
        <div class="research-stage-meta">
          <div>
            <span>编排模式</span>
            <strong>{stage().pattern}</strong>
            <small>{stage().team}</small>
          </div>
          <div>
            <span>默认负责角色</span>
            <strong>{stage().role}</strong>
            <small>@{stage().agent}</small>
          </div>
          <div>
            <span>完成验证</span>
            <strong>{stage().verification}</strong>
          </div>
          <div>
            <span>约定产物</span>
            <strong>{stage().artifact}</strong>
          </div>
        </div>

        <div class="research-stage-section-head">
          <div>
            <span class="eyebrow">AGENT ACTIVITY</span>
            <h3>Agent 任务与阶段性结果</h3>
          </div>
          <span>{activity().entries.length} 项任务</span>
        </div>

        <Show
          when={activity().entries.length > 0}
          fallback={
            <div class="stage-awaiting research-stage-awaiting">
              <span>等待调度</span>
              <strong>{stage().role}</strong>
              <small>Agent 开始工作后，任务、模型、耗时和结果会在这里实时更新。</small>
            </div>
          }
        >
          <div class="stage-agent-list research-stage-agent-list">
            <For each={activity().entries}>
              {(entry) => (
                <article class="stage-agent-task" data-phase={entry.phase}>
                  <div class="stage-agent-head">
                    <div>
                      <span class="agent-state" data-phase={entry.phase} />
                      <strong class="stage-agent-role">{entry.role}</strong>
                      <span class="stage-agent-id">@{entry.agent}</span>
                    </div>
                    <span class="stage-agent-phase">
                      {agentPhaseLabel(entry.phase)}
                      <Show when={entry.durationMs}>
                        {(duration) => ` · ${(duration() / 1000).toFixed(1)}s`}
                      </Show>
                    </span>
                  </div>
                  <div class="stage-task">
                    <span>当前任务</span>
                    <p>{entry.task}</p>
                  </div>
                  <Show when={entry.model}>
                    {(model) => (
                      <div class="stage-model">
                        <span>模型</span>
                        {entry.provider ? `${entry.provider} / ` : ''}
                        {model()}
                      </div>
                    )}
                  </Show>
                  <Show
                    when={entry.result || entry.error}
                    fallback={<div class="stage-result-empty">阶段性结果：暂无</div>}
                  >
                    <details class="stage-result" open>
                      <summary>阶段性结果：{entry.error ? '执行异常' : '已有结果'}</summary>
                      <pre>{entry.error || entry.result}</pre>
                    </details>
                  </Show>
                </article>
              )}
            </For>
          </div>
        </Show>
      </section>

      <div class="execution-checkpoint research-stage-checkpoint">
        <IconShield size={15} />
        <span>
          <strong>科研审批渠道未配置</strong>
          当前工作流检查点由主会话模型审查，不构成人类批准；研究执行与结论发布尚未接入科研审批。
        </span>
      </div>
    </div>
  )
}

function workflowActivityNodes(item: TranscriptItem): ActivityNode[] {
  if (item.workflow) {
    return item.workflow.nodes.flatMap((node) =>
      node.kind === 'checkpoint'
        ? []
        : [
            {
              id: node.id,
              agent: node.agent,
              task: node.task,
              ...(node.provider ? { provider: node.provider } : {}),
              ...(node.model ? { model: node.model } : {}),
            },
          ],
    )
  }

  if (!Array.isArray(item.args?.nodes)) return []
  return item.args.nodes.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const node = value as Record<string, unknown>
    if (node.kind === 'checkpoint') return []
    const id = stringValue(node.id)
    const task = stringValue(node.task)
    if (!id || !task) return []
    const model = stringValue(node.model)
    const provider = stringValue(node.provider)
    return [
      {
        id,
        agent: stringValue(node.agent),
        task,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    ]
  })
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stageIndexFor(agent: string, task: string): number {
  const exact = RESEARCH_CHAIN.findIndex((stage) => stage.agent === agent)
  if (exact >= 0) return exact
  if (agent === 'clinical-challenger') return 0
  if (agent === 'reproducibility-auditor') return 4
  const source = `${agent} ${task}`.toLowerCase()
  const hints = [
    ['question', 'literature', 'evidence', '问题', '文献', '证据检索'],
    ['data', 'audit', 'dataset', '数据', '队列', '标签'],
    ['protocol', 'statistic', '方案', '统计', '指标'],
    ['experiment', 'engineer', 'train', '实验', '训练', '消融'],
    ['review', 'verify', '复核', '核验', '敏感性'],
    ['writer', 'report', 'paper', '写作', '报告', '论文'],
  ]
  return hints.findIndex((words) => words.some((word) => source.includes(word)))
}

function settledPhase(item: TranscriptItem): string {
  if (item.status === 'success') return 'done'
  if (item.status === 'failure') return 'failed'
  return 'working'
}

function resultFields(
  live: WorkflowNodeState | undefined,
  output?: string,
  error?: string,
): Pick<StageActivity, 'result' | 'error'> {
  const failure = stringValue(error)
  if (failure) return { error: failure }
  const result = stringValue(output) || stringValue(live?.output) || stringValue(live?.summary)
  return result ? { result } : {}
}

function checkpointStage(item?: TranscriptItem): number {
  const projection = item?.workflow
  if (!projection || projection.phase !== 'waiting_review' || !projection.checkpointId) return -1
  const checkpoint = projection.nodes.find(
    (node) => node.kind === 'checkpoint' && node.id === projection.checkpointId,
  )
  if (!checkpoint || checkpoint.kind !== 'checkpoint') return -1
  return Math.max(
    -1,
    ...checkpoint.needs.map((id) => {
      const node = projection.nodes.find((candidate) => candidate.id === id)
      return node && node.kind !== 'checkpoint' ? stageIndexFor(node.agent, node.task) : -1
    }),
  )
}

function stageStatus(entries: StageActivity[]): StageStatus {
  if (entries.some((entry) => entry.phase === 'failed')) return 'failed'
  if (
    entries.some(
      (entry) => entry.phase === 'queued' || entry.phase === 'working' || entry.phase === 'spawned',
    )
  ) {
    return 'in_progress'
  }
  if (
    entries.length > 0 &&
    entries.every((entry) => entry.phase === 'done' || entry.phase === 'skipped')
  ) {
    return 'completed'
  }
  return 'pending'
}

function statusLabel(status: StageStatus): string {
  if (status === 'in_progress') return '进行中'
  if (status === 'waiting_review') return '待审核'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '待调度'
}

function agentPhaseLabel(phase: string): string {
  if (phase === 'queued') return '排队中'
  if (phase === 'working' || phase === 'spawned') return '执行中'
  if (phase === 'done') return '已完成'
  if (phase === 'failed') return '失败'
  if (phase === 'skipped') return '已跳过'
  return '等待调度'
}
