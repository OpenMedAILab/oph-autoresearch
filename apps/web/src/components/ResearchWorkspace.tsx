import { createMemo, For, Show } from 'solid-js'
import { collapseWorkflowItems } from '../lib/render-items.ts'
import type { TranscriptItem, WorkflowNodeState } from '../lib/store/index.ts'
import { centerView, isRunning, setCenterView, transcript } from '../lib/store/index.ts'
import { IconCheck, IconChevron, IconShield } from './Icons.tsx'
import RemoteSshBrowser from './RemoteSshBrowser.tsx'

type StageStatus = 'pending' | 'in_progress' | 'waiting_review' | 'completed' | 'failed'

interface StageDefinition {
  name: string
  detail: string
  agent: string
  role: string
  artifact: string
}

interface StageActivity {
  key: string
  agent: string
  role: string
  task: string
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
  model?: string
}

const RESEARCH_CHAIN: readonly StageDefinition[] = [
  {
    name: '问题建模',
    detail: '明确临床问题、研究终点、证据缺口与可证伪假设。',
    agent: 'research-questioner',
    role: '研究问题与证据检索员',
    artifact: 'research/research_question.yaml',
  },
  {
    name: '数据审计',
    detail: '核查队列规模、标签质量、缺失值、偏倚与数据泄漏风险。',
    agent: 'data-auditor',
    role: '数据审计员',
    artifact: 'research/dataset_manifest.json',
  },
  {
    name: '方案冻结',
    detail: '冻结纳排标准、数据拆分、评价指标、统计方法与人工检查点。',
    agent: 'protocol-statistician',
    role: '方案与统计设计员',
    artifact: 'study_protocol.md · experiment_spec.yaml',
  },
  {
    name: '远程实验',
    detail: '在 SSH 工作区执行基线训练、消融实验、误差分析与运行监控。',
    agent: 'experiment-engineer',
    role: '实验工程师',
    artifact: 'research/run_receipt.json',
  },
  {
    name: '独立复核',
    detail: '独立核验统计结论、负结果、敏感性分析与证据追踪关系。',
    agent: 'independent-reviewer',
    role: '独立复核员',
    artifact: 'research/claim_evidence_map.yaml',
  },
  {
    name: '研究输出',
    detail: '整理图表、方法描述、模型卡、研究报告与可复现归档。',
    agent: 'evidence-writer',
    role: '证据写作与报告员',
    artifact: '研究报告 · 模型卡 · 论文草稿',
  },
] as const

export function ResearchWorkspace() {
  return (
    <div class="workspace-view">
      <button class="workspace-back" type="button" onClick={() => setCenterView('chat')}>
        <IconChevron size={12} dir="left" /> 返回 Agent 对话
      </button>
      <Show when={centerView() === 'workflow'}>
        <WorkflowOverview />
      </Show>
      <Show when={centerView() === 'ssh'}>
        <RemoteSshBrowser />
      </Show>
    </div>
  )
}

function WorkflowOverview() {
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
  const directTasks = createMemo(() => delegated().filter((item) => item.toolName === 'subagent'))

  const activities = createMemo(() => {
    const byStage = RESEARCH_CHAIN.map(() => [] as StageActivity[])
    const current = workflow()

    if (current) {
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

    const waitingStage = checkpointStage(current)
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
    if (current === 'waiting_review') return '等待人工审核'
    if (isRunning() || activities().some((stage) => stage.status === 'in_progress')) return '执行中'
    if (current === 'completed') return '本轮已完成'
    if (delegated().length > 0) return '等待继续'
    return '尚未启动'
  })

  return (
    <div class="workflow-overview">
      <header class="workspace-view-head">
        <div>
          <span class="eyebrow">RESEARCH EXECUTION CHAIN</span>
          <h2>研究执行链</h2>
          <p>按阶段查看负责 Agent、当前任务、执行状态和已经形成的阶段性结果。</p>
        </div>
        <span
          class="workflow-status"
          data-status={workflow()?.workflow?.phase || (isRunning() ? 'running' : 'idle')}
        >
          <span /> {overallStatus()}
        </span>
      </header>

      <section class="execution-chain" aria-label="研究执行链">
        <div class="execution-chain-summary">
          <div>
            <strong>六阶段研究流程</strong>
            <span>
              {completed()} / {RESEARCH_CHAIN.length} 个阶段已完成
            </span>
          </div>
          <span>
            {workflow()?.workflow?.workflowId ? '实时同步当前工作流' : '等待 Agent 建立工作流'}
          </span>
        </div>

        <ol class="execution-chain-list">
          <For each={RESEARCH_CHAIN}>
            {(stage, index) => {
              const stageActivity = () => activities()[index()]!
              return (
                <li data-status={stageActivity().status}>
                  <span class="execution-step">
                    <Show
                      when={stageActivity().status === 'completed'}
                      fallback={String(index() + 1).padStart(2, '0')}
                    >
                      <IconCheck size={13} />
                    </Show>
                  </span>
                  <div class="execution-stage-body">
                    <div class="execution-stage-title">
                      <div>
                        <strong>{stage.name}</strong>
                        <p>{stage.detail}</p>
                      </div>
                      <span class="execution-state">{statusLabel(stageActivity().status)}</span>
                    </div>

                    <Show
                      when={stageActivity().entries.length > 0}
                      fallback={
                        <div class="stage-awaiting">
                          <span>负责 Agent</span>
                          <strong>{stage.role}</strong>
                          <small>@{stage.agent} · 待调度</small>
                        </div>
                      }
                    >
                      <div class="stage-agent-list">
                        <For each={stageActivity().entries}>
                          {(activity) => (
                            <article class="stage-agent-task" data-phase={activity.phase}>
                              <div class="stage-agent-head">
                                <div>
                                  <span class="agent-state" data-phase={activity.phase} />
                                  <strong class="stage-agent-role">{activity.role}</strong>
                                  <span class="stage-agent-id">@{activity.agent}</span>
                                </div>
                                <span class="stage-agent-phase">
                                  {agentPhaseLabel(activity.phase)}
                                  <Show when={activity.durationMs}>
                                    {(duration) => ` · ${(duration() / 1000).toFixed(1)}s`}
                                  </Show>
                                </span>
                              </div>
                              <div class="stage-task">
                                <span>当前任务</span>
                                <p>{activity.task}</p>
                              </div>
                              <Show when={activity.model}>
                                {(model) => (
                                  <div class="stage-model">
                                    <span>模型</span>
                                    {model()}
                                  </div>
                                )}
                              </Show>
                              <Show
                                when={activity.result || activity.error}
                                fallback={<div class="stage-result-empty">阶段性结果：暂无</div>}
                              >
                                <details class="stage-result">
                                  <summary>
                                    阶段性结果：{activity.error ? '执行异常' : '已有结果'}
                                  </summary>
                                  <pre>{activity.error || activity.result}</pre>
                                </details>
                              </Show>
                            </article>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="stage-artifact">
                      <span>约定产物</span>
                      {stage.artifact}
                    </div>
                  </div>
                </li>
              )
            }}
          </For>
        </ol>

        <div class="execution-checkpoint">
          <IconShield size={15} />
          <span>
            <strong>人工检查点</strong>
            训练方案、统计结论与结果发布必须由研究者确认；审核状态会直接标在对应阶段。
          </span>
        </div>
      </section>
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
    return [
      {
        id,
        agent: stringValue(node.agent),
        task,
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
  if (entries.some((entry) => entry.phase === 'working' || entry.phase === 'spawned')) {
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
  if (phase === 'working' || phase === 'spawned') return '执行中'
  if (phase === 'done') return '已完成'
  if (phase === 'failed') return '失败'
  if (phase === 'skipped') return '已跳过'
  return '等待调度'
}
