import { createEffect, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { loadTeamClis, sendMessage, setComposerSeed, state, workspace } from '../lib/store/index.ts'
import {
  IconActivity,
  IconBrain,
  IconCheck,
  IconEye,
  IconShield,
  IconTarget,
  IconTerminal,
} from './Icons.tsx'
import {
  buildResearchPrompt,
  isResearchInputReady,
  type ResearchLaunchInput,
} from './research-prompt.ts'

const STORAGE_KEY = 'oph-autoresearch.launchpad.v1'

const DEFAULT_INPUT: ResearchLaunchInput = {
  direction: '',
  modality: '眼底彩照',
  task: '疾病分类',
  sshAlias: '',
  remotePath: '',
}

const PIPELINE = [
  {
    index: '01',
    name: '问题建模',
    detail: '临床问题 · 研究终点 · 可证伪假设',
    artifact: 'research_question.yaml',
  },
  {
    index: '02',
    name: '数据审计',
    detail: '队列规模 · 标签质量 · 泄漏风险',
    artifact: 'dataset_manifest.json',
  },
  {
    index: '03',
    name: '方案冻结',
    detail: '拆分策略 · 指标 · 人工检查点',
    artifact: 'study_protocol.md',
  },
  {
    index: '04',
    name: '远程实验',
    detail: '基线训练 · 消融实验 · 运行监控',
    artifact: 'experiment_spec.yaml',
  },
  {
    index: '05',
    name: '独立复核',
    detail: '统计检验 · 负结果 · 证据追踪',
    artifact: 'claim_evidence_map.yaml',
  },
  {
    index: '06',
    name: '研究输出',
    detail: '图表 · 方法描述 · 可复现归档',
    artifact: 'run_receipt.json',
  },
] as const

function readInput(): ResearchLaunchInput {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '',
    ) as Partial<ResearchLaunchInput>
    return { ...DEFAULT_INPUT, ...parsed }
  } catch {
    return DEFAULT_INPUT
  }
}

export function ResearchLaunchpad() {
  const initial = readInput()
  const [direction, setDirection] = createSignal(initial.direction)
  const [modality, setModality] = createSignal(initial.modality)
  const [task, setTask] = createSignal(initial.task)
  const [sshAlias, setSshAlias] = createSignal(initial.sshAlias)
  const [remotePath, setRemotePath] = createSignal(initial.remotePath)
  const [cliAgents] = createResource(loadTeamClis)

  const input = (): ResearchLaunchInput => ({
    direction: direction(),
    modality: modality(),
    task: task(),
    sshAlias: sshAlias(),
    remotePath: remotePath(),
  })

  createEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(input()))
  })

  const connectedAgents = () => loaded(cliAgents)?.agents.filter((agent) => agent.connected) ?? []
  const start = () => {
    const current = input()
    if (!isResearchInputReady(current) || state.connection !== 'ready') return
    sendMessage(buildResearchPrompt(current))
  }

  return (
    <section class="research-launchpad" aria-label="创建眼科影像研究">
      <div class="research-shell">
        <header class="research-hero">
          <div class="research-hero-copy">
            <p class="research-kicker">
              <span class="research-live-dot" /> OPH RESEARCH WORKSPACE
            </p>
            <h2>从临床问题，到可复现证据</h2>
            <p class="research-summary">
              面向眼科影像与 AI 模型研究的多 Agent 工作台。原始数据留在服务器，研究过程全程可审计。
            </p>

            <div class="research-capabilities">
              <span>
                <IconShield size={15} /> 本地脱敏
              </span>
              <span>
                <IconTerminal size={15} /> SSH 运算
              </span>
              <span>
                <IconBrain size={15} /> 多模型复核
              </span>
            </div>
          </div>

          <div class="research-retina" aria-hidden="true">
            <svg viewBox="0 0 240 172" role="presentation">
              <path
                class="retina-orbit"
                d="M18 87c23-38 58-58 102-58s79 20 102 58c-23 38-58 58-102 58S41 125 18 87Z"
              />
              <circle class="retina-ring retina-ring-one" cx="120" cy="87" r="40" />
              <circle class="retina-ring retina-ring-two" cx="120" cy="87" r="23" />
              <circle class="retina-core" cx="120" cy="87" r="8" />
              <path
                class="retina-vessel"
                d="M120 79 91 54M116 89 77 96M122 92l27 32M125 84l36-22M111 83 75 72M127 90l44 10"
              />
              <circle class="retina-node" cx="91" cy="54" r="3" />
              <circle class="retina-node" cx="77" cy="96" r="3" />
              <circle class="retina-node" cx="149" cy="124" r="3" />
              <circle class="retina-node" cx="161" cy="62" r="3" />
              <circle class="retina-node" cx="75" cy="72" r="3" />
              <circle class="retina-node" cx="171" cy="100" r="3" />
            </svg>
            <div class="research-engine-state">
              <span /> Research engine ready
            </div>
          </div>
        </header>

        <div class="research-runtime">
          <div>
            <span class="research-runtime-label">当前研究空间</span>
            <strong>{workspace()?.name ?? '未选择项目'}</strong>
          </div>
          <span class="research-runtime-separator" />
          <div>
            <span class="research-runtime-label">执行资源</span>
            <Show when={connectedAgents().length > 0} fallback={<strong>API Agent 就绪</strong>}>
              <strong>{connectedAgents().length} 个 CLI Agent 在线</strong>
            </Show>
          </div>
          <span class="research-runtime-spacer" />
          <span class="research-runtime-safe">
            <IconCheck size={14} /> 数据边界已启用
          </span>
        </div>

        <div class="research-body">
          <section class="research-card research-setup">
            <div class="research-card-head">
              <div class="research-section-icon">
                <IconTarget size={18} />
              </div>
              <div>
                <span class="research-overline">START HERE</span>
                <h3>定义本轮研究</h3>
              </div>
              <span class="research-step-count">01 / 06</span>
            </div>

            <form class="research-form" onSubmit={(event) => event.preventDefault()}>
              <label class="research-field research-field-wide">
                <span>研究问题</span>
                <textarea
                  rows={3}
                  value={direction()}
                  placeholder="例如：基于眼底彩照预测糖尿病视网膜病变进展风险"
                  onInput={(event) => setDirection(event.currentTarget.value)}
                />
                <small>用一句话描述研究对象、输入数据和预期终点。</small>
              </label>

              <label class="research-field">
                <span>影像模态</span>
                <select
                  value={modality()}
                  onChange={(event) => setModality(event.currentTarget.value)}
                >
                  <option>眼底彩照</option>
                  <option>OCT</option>
                  <option>OCTA</option>
                  <option>裂隙灯</option>
                  <option>多模态</option>
                </select>
              </label>

              <label class="research-field">
                <span>任务类型</span>
                <select value={task()} onChange={(event) => setTask(event.currentTarget.value)}>
                  <option>疾病分类</option>
                  <option>病灶分割</option>
                  <option>风险预测</option>
                  <option>表征学习</option>
                </select>
              </label>

              <label class="research-field">
                <span>SSH 计算节点</span>
                <input
                  value={sshAlias()}
                  placeholder="例如：oph-gpu"
                  onInput={(event) => setSshAlias(event.currentTarget.value)}
                />
              </label>

              <label class="research-field">
                <span>远程数据路径</span>
                <input
                  value={remotePath()}
                  placeholder="例如：/data/oph/retina"
                  onInput={(event) => setRemotePath(event.currentTarget.value)}
                />
              </label>

              <div class="research-boundary research-field-wide">
                <span class="research-boundary-icon">
                  <IconShield size={16} />
                </span>
                <div>
                  <strong>原始影像不离开服务器</strong>
                  <span>Agent 仅回传脱敏清单、统计汇总与可审计运行回执。</span>
                </div>
              </div>

              <div class="research-actions research-field-wide">
                <button
                  class="research-secondary"
                  type="button"
                  disabled={!isResearchInputReady(input())}
                  onClick={() => setComposerSeed(buildResearchPrompt(input()))}
                >
                  预览研究指令
                </button>
                <button
                  class="research-primary"
                  type="button"
                  disabled={!isResearchInputReady(input()) || state.connection !== 'ready'}
                  onClick={start}
                >
                  <IconActivity size={16} />
                  启动研究编排
                </button>
              </div>
            </form>
          </section>

          <aside class="research-card research-pipeline">
            <div class="research-card-head research-pipeline-head">
              <div class="research-section-icon">
                <IconEye size={18} />
              </div>
              <div>
                <span class="research-overline">EVIDENCE PIPELINE</span>
                <h3>研究执行链</h3>
              </div>
              <span class="research-stage-total">6 STAGES</span>
            </div>

            <ol>
              <For each={PIPELINE}>
                {(stage) => (
                  <li>
                    <span class="research-stage-index">{stage.index}</span>
                    <div class="research-stage-copy">
                      <strong>{stage.name}</strong>
                      <p>{stage.detail}</p>
                      <code>{stage.artifact}</code>
                    </div>
                  </li>
                )}
              </For>
            </ol>

            <div class="research-checkpoint">
              <IconShield size={16} />
              <div>
                <strong>人工检查点</strong>
                <span>方案冻结与结论发布前必须由研究者确认</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}
