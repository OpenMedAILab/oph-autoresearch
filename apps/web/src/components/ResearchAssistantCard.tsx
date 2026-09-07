import { createResource, createSignal, For, Show } from 'solid-js'
import {
  client,
  isRunning,
  researchRefreshVersion,
  sendMessage,
  setCenterView,
  state,
  workspace,
} from '../lib/store/index.ts'

type Document = {
  id: string
  kind: string
  version: number
  contentHash: string
  verified: boolean
  stale: boolean
  document?: Record<string, unknown>
}
type Research = {
  campaignId: string
  goal: string
  version: number
  studySelection: unknown
  selectionStale: boolean
  documents: Document[]
}

export function ResearchAssistantCard() {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [snapshot, { refetch }] = createResource(
    () => {
      const ws = workspace()?.id,
        conversation = state.activeConversation
      return ws && conversation
        ? { ws, conversation, version: researchRefreshVersion(ws, conversation) }
        : undefined
    },
    async ({ ws, conversation }) =>
      client.api<{ campaigns: Research[] }>(
        `/api/research/assistant?ws=${encodeURIComponent(ws)}&conversationId=${encodeURIComponent(conversation)}`,
      ),
  )
  const studies = () => snapshot()?.campaigns ?? []
  const current = (r: Research, kind: string) =>
    r.documents.filter((d) => d.kind === kind && d.verified && !d.stale).at(-1)
  async function confirm(r: Research, study: Document) {
    const ws = workspace()?.id
    if (!ws || busy() || isRunning()) return
    setBusy(true)
    setError('')
    try {
      await client.api(
        `/api/research/campaigns/${r.campaignId}/assistant/confirm?ws=${encodeURIComponent(ws)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            documentId: study.id,
            contentHash: study.contentHash,
            expectedVersion: r.version,
            requestId: crypto.randomUUID(),
          }),
        },
      )
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认失败，请刷新方案后重试')
      await refetch()
    } finally {
      setBusy(false)
    }
  }
  const plain = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <section class="research-assistant-card" aria-label="主控科研助手">
      <Show
        when={studies().length}
        fallback={
          <p class="research-assistant-hint">
            告诉主控一个研究主题，即可开始文献与刊会调研。已有项目目录会自动沿用。
          </p>
        }
      >
        <For each={studies()}>
          {(research) => (
            <details open={studies().length === 1}>
              <summary>
                <strong>{research.goal}</strong>
                <span>
                  {current(research, 'peerreview')
                    ? '已有稿件审阅'
                    : current(research, 'manuscript')
                      ? '已有证据稿件'
                      : current(research, 'handoff')
                        ? '实验准备已保存'
                        : research.studySelection
                          ? '方案已确认 · 准备交接'
                          : current(research, 'study')
                            ? '请确认研究方案'
                            : '资料与课题调研'}
                </span>
              </summary>
              <div class="research-assistant-content">
                <Show when={research.selectionStale}>
                  <output>方案或目录已变化，请查看当前内容后重新确认。</output>
                </Show>
                <Show when={current(research, 'study')}>
                  {(study) => (
                    <div class="research-study-card">
                      <strong>研究方案 · 第 {study().version} 版</strong>
                      <p>{plain(study().document?.question)}</p>
                      <details>
                        <summary>查看实验方案、资源与停止条件</summary>
                        <ResearchFields value={study().document} />
                      </details>
                      <Show
                        when={!research.studySelection}
                        fallback={
                          <p>已确认此版本。实验准备会在本对话继续，正式运行沿用已有执行授权。</p>
                        }
                      >
                        <div class="research-assistant-actions">
                          <button
                            type="button"
                            class="btn-primary"
                            disabled={busy() || isRunning()}
                            onClick={() => void confirm(research, study())}
                          >
                            {busy() ? '正在确认…' : '确认方案并继续'}
                          </button>
                          <button
                            type="button"
                            disabled={busy() || isRunning()}
                            onClick={() =>
                              sendMessage(
                                `请修改“${research.goal}”的当前研究方案。先说明可调整的课题、目标刊会和实验选项，等待我补充具体意见。`,
                              )
                            }
                          >
                            修改方案
                          </button>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
                <div class="research-assistant-actions">
                  <span>
                    {research.documents.filter((d) => d.kind === 'evidence' && !d.stale).length}{' '}
                    份资料 ·{' '}
                    {research.documents.filter((d) => d.kind === 'venue' && !d.stale).length}{' '}
                    份刊会档案
                  </span>
                  <button
                    type="button"
                    disabled={isRunning()}
                    onClick={() =>
                      sendMessage(
                        `请继续“${research.goal}”，读取现有研究状态与文档，恢复已有任务。若方案尚未确认，完成调研后等待方案卡确认；已确认则实际编排实验准备，避免重复已完成工作。`,
                      )
                    }
                  >
                    继续研究
                  </button>
                  <button type="button" onClick={() => setCenterView('research')}>
                    高级详情
                  </button>
                </div>
                <details>
                  <summary>资料、刊会与研究产物</summary>
                  <For each={research.documents.filter((d) => !d.stale)}>
                    {(doc) => (
                      <details>
                        <summary>
                          {plain(
                            doc.document?.name ??
                              doc.document?.title ??
                              (
                                {
                                  handoff: '实验交接包',
                                  peerreview: '稿件审稿意见',
                                  reviewcase: '审稿校准案例',
                                  manuscript: '证据稿件',
                                } as Record<string, string>
                              )[doc.kind] ??
                              doc.kind,
                          )}{' '}
                          · 第 {doc.version} 版
                        </summary>
                        <Show when={doc.kind === 'venue'}>
                          <p>官方要求依据来源记录；范文写法是阅读归纳，不是投稿硬性要求。</p>
                        </Show>
                        <Show when={doc.kind === 'evidence'}>
                          <p>
                            阅读范围：{plain(doc.document?.readingDepth)}
                            ；保存核验不等于来源内容已独立验证。
                          </p>
                        </Show>
                        <ResearchFields value={doc.document} />
                      </details>
                    )}
                  </For>
                </details>
              </div>
            </details>
          )}
        </For>
      </Show>
      <Show when={error() || snapshot.error}>
        <p role="alert">
          {error() || '研究资料暂时无法读取。'}{' '}
          <button type="button" onClick={() => void refetch()}>
            重新读取
          </button>
        </p>
      </Show>
    </section>
  )
}

const fieldNames: Record<string, string> = {
  question: '研究问题',
  PICO: '研究设计',
  population: '人群与数据',
  intervention: '模型或干预',
  comparison: '对照',
  outcome: '主要结局',
  protocol: '实验方案',
  candidates: '候选课题比较',
  targetVenues: '投稿目标',
  experiments: '基线与消融',
  budget: '资源范围',
  stopRules: '停止条件',
  endpoints: '评价指标',
  splitPlan: '数据划分',
  unit: '划分单位',
  description: '说明',
  codeVersion: '代码准备',
  counterEvidence: '反证与局限',
  evidenceCitations: '参考证据',
  title: '题名',
  url: '来源',
  retrievedAt: '获取时间',
  readingDepth: '阅读范围',
  license: '使用范围',
  segments: '内容证据',
  locator: '定位',
  text: '内容',
  name: '刊会名称',
  venueType: '类型',
  year: '届次',
  track: '投稿方向',
  officialUrl: '官方入口',
  fit: '适配判断',
  rules: '官方要求',
  publishedAt: '发布日期',
  exemplars: '代表论文',
  reason: '选入理由',
  citationCount: '引用统计',
  citationSource: '统计来源',
  citationCheckedAt: '查询时间',
  writingInferences: '范文写法归纳',
  unknowns: '待核验事项',
  summary: '准备结果',
  tasks: '实验任务',
  expectedOutputs: '预期产物',
  blockers: '执行缺项',
  reviews: '审稿意见',
  role: '审阅职责',
  priority: '严重程度',
  comment: '问题',
  suggestion: '修改建议',
  revisionRound: '返修轮次',
  manuscript: '被审稿件',
  manuscriptVersion: '稿件版本',
  review: '真实审稿意见',
  source: '来源',
  sourceKind: '来源类型',
  usage: '允许用途',
  split: '数据分组',
  deidentified: '已脱敏',
  round: '审稿轮次',
  venue: '投稿刊会',
}
function ResearchFields(props: { value: unknown }) {
  const rows = () =>
    props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? Object.entries(props.value as Record<string, unknown>).filter(
          ([key]) =>
            ![
              'key',
              'previousVersion',
              'studyHash',
              'manuscriptHash',
              'evidenceKeys',
              'evidenceKey',
              'paperGroup',
              'evidenceCitations',
            ].includes(key),
        )
      : []
  const render = (value: unknown): string =>
    value === null
      ? '尚未核实'
      : typeof value === 'string'
        ? ((
            {
              'partial-full-text': '部分正文（未确认完整性）',
              'full-text': '全文',
              abstract: '摘要',
              metadata: '仅元数据',
              'not prepared': '尚未准备',
              patient: '患者',
              journal: '期刊',
              conference: '会议',
              major: '主要问题',
              minor: '次要问题',
            } as Record<string, string>
          )[value] ?? value)
        : String(value)
  return (
    <Show when={rows().length} fallback={<span>{render(props.value)}</span>}>
      <dl class="research-field-list">
        <For each={rows()}>
          {([key, value]) => (
            <div>
              <dt>{fieldNames[key] ?? key}</dt>
              <dd>
                <Show
                  when={Array.isArray(value)}
                  fallback={
                    <Show when={value && typeof value === 'object'} fallback={render(value)}>
                      <ResearchFields value={value} />
                    </Show>
                  }
                >
                  <ul>
                    <For each={value as unknown[]}>
                      {(entry) => (
                        <li>
                          <Show when={entry && typeof entry === 'object'} fallback={render(entry)}>
                            <ResearchFields value={entry} />
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  )
}
