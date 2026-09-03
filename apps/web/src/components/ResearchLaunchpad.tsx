import { createEffect, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { loadTeamClis, sendMessage, setComposerSeed, state, workspace } from '../lib/store/index.ts'
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
  { index: '01', name: '研究问题', artifact: 'research_question.yaml' },
  { index: '02', name: '远程数据审计', artifact: 'dataset_manifest.json' },
  { index: '03', name: '方案冻结', artifact: 'study_protocol.md' },
  { index: '04', name: '基线实验', artifact: 'experiment_spec.yaml' },
  { index: '05', name: '训练监控', artifact: 'run_receipt.json' },
  { index: '06', name: '结果复核', artifact: 'claim_evidence_map.yaml' },
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
      <div class="research-hero">
        <div>
          <p class="research-kicker">OPH AUTORESEARCH · MVP</p>
          <h2>从研究问题到可复现实验</h2>
          <p class="research-summary">本机组织与审计，SSH 服务器保存影像并执行计算。</p>
        </div>
        <div class="research-runtime">
          <span>{workspace()?.name ?? '未选择项目'}</span>
          <span class="research-runtime-separator" />
          <Show when={connectedAgents().length > 0} fallback={<span>API Agent</span>}>
            <span>{connectedAgents().length} 个 CLI Agent</span>
          </Show>
        </div>
      </div>

      <div class="research-body">
        <form class="research-form" onSubmit={(event) => event.preventDefault()}>
          <label class="research-field research-field-wide">
            <span>研究方向</span>
            <textarea
              rows={3}
              value={direction()}
              placeholder="例如：基于眼底彩照预测糖尿病视网膜病变进展风险"
              onInput={(event) => setDirection(event.currentTarget.value)}
            />
          </label>

          <label class="research-field">
            <span>影像模态</span>
            <select value={modality()} onChange={(event) => setModality(event.currentTarget.value)}>
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
            <span>SSH 主机别名</span>
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
            <span class="research-boundary-mark">●</span>
            原始影像不离开服务器；Agent 仅回传脱敏清单与汇总结果。
          </div>

          <div class="research-actions research-field-wide">
            <button
              class="research-secondary"
              type="button"
              disabled={!isResearchInputReady(input())}
              onClick={() => setComposerSeed(buildResearchPrompt(input()))}
            >
              检查任务指令
            </button>
            <button
              class="research-primary"
              type="button"
              disabled={!isResearchInputReady(input()) || state.connection !== 'ready'}
              onClick={start}
            >
              启动方案设计
            </button>
          </div>
        </form>

        <div class="research-pipeline">
          <div class="research-pipeline-head">
            <span>标准研究流程</span>
            <span>首个检查点：方案冻结</span>
          </div>
          <ol>
            <For each={PIPELINE}>
              {(stage) => (
                <li>
                  <span class="research-stage-index">{stage.index}</span>
                  <div>
                    <strong>{stage.name}</strong>
                    <code>{stage.artifact}</code>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </div>
      </div>
    </section>
  )
}
