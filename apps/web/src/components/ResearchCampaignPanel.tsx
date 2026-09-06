import type {
  ResearchCampaign,
  ResearchExecutionStage,
  ResearchTemplateId,
  ResearchWriteResult,
} from '@oph-autoresearch/core'
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from 'solid-js'
import { requestHumanApproval } from '../lib/research-approval.ts'
import {
  client,
  explainApiError,
  researchRefreshVersion,
  state,
  workspace,
} from '../lib/store/index.ts'
import { ResearchExperimentResult } from './ResearchExperimentResult.tsx'
import { ResearchPatternPanel } from './ResearchPatternPanel.tsx'

const stageLabels = {
  question: '问题建模',
  data_audit: '数据审计',
  protocol: '方案冻结',
  execution: '远程实验',
  review: '独立复核',
  output: '研究输出',
}
const executionStageMap: Record<ResearchExecutionStage, keyof typeof stageLabels> = {
  question: 'question',
  literature: 'data_audit',
  dataset_audit: 'data_audit',
  protocol_freeze: 'protocol',
  smoke: 'execution',
  experiment: 'execution',
  evaluation: 'execution',
  independent_review: 'review',
  release: 'output',
}
const executionLabels: Record<ResearchExecutionStage, string> = {
  question: '问题',
  literature: '文献',
  dataset_audit: '数据审计',
  protocol_freeze: '方案冻结',
  smoke: '冒烟验证',
  experiment: '实验',
  evaluation: '评估',
  independent_review: '独立复核',
  release: '发布',
}
const templates: Array<{ id: ResearchTemplateId; label: string }> = [
  { id: 'synthetic-summary-v1', label: '摘要检查' },
  { id: 'synthetic-evaluation-v1', label: '合成评分评估' },
  { id: 'synthetic-training-evaluation-v1', label: '合成特征评估' },
  { id: 'synthetic-retinal-image-v1', label: '合成眼底图像实验' },
  { id: 'supervised-phantom-v2', label: '真实训练：合成图像双模型比较' },
]
const taskStatuses = {
  pending: '待执行',
  verified: '已核验',
  failed: '失败',
  interrupted: '中断',
  stale: '来源已更新',
}
const reviewStatuses = {
  reserved: '已预留',
  running: '审阅中',
  done: '已完成',
  failed: '失败',
  unknown: '状态待核对',
}
const approvalKinds = {
  execution: '实验执行审批',
  protocol: '研究方案审批',
  model_review: '独立复核审批',
  release: '结论发布审批',
}
const templateName = (id: string) =>
  templates.find((template) => template.id === id)?.label ?? '研究任务'
function runName(campaign: ResearchCampaign, id: string | undefined) {
  const index = campaign.attempts.findIndex((attempt) => attempt.id === id)
  return index < 0 ? '人工登记' : `第 ${index + 1} 次运行`
}
function approvalConsumer(campaign: ResearchCampaign, id: string) {
  const run = campaign.attempts.findIndex((item) => item.id === id)
  if (run >= 0) return `第 ${run + 1} 次运行`
  const review = campaign.modelReviews?.findIndex((item) => item.id === id) ?? -1
  return review >= 0 ? `第 ${review + 1} 次独立复核` : '对应任务'
}
function readableReview(text: string) {
  try {
    const result = JSON.parse(text) as {
      decision?: string
      claims?: Array<{ claim: string }>
      limitations?: string[]
    }
    return [
      result.decision === 'supported' ? '当前主张有证据支持' : '当前证据不足',
      ...(result.claims ?? []).map((item) => item.claim),
      ...(result.limitations ?? []).map((item) => `局限：${item}`),
    ].join('\n\n')
  } catch {
    return '审阅结果尚未形成可核验的结构化结论。'
  }
}
const statusLabels = {
  proposal: '未批准提案',
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  completed: '已完成',
  cancelled: '已取消',
}

const attemptLabels = {
  unknown: '状态未知，等待核对',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已确认取消',
  interrupted: '中断待核对',
}
const backendLabels = {
  'builtin-local': '内置本地',
  'localhost-daemon': '本机守护进程',
  'ssh-daemon': 'SSH 远端守护进程',
}

function campaignProgress(campaign: ResearchCampaign) {
  if (campaign.status === 'completed') return '研究输出已发布'
  if (campaign.attempts.some((attempt) => attempt.status === 'running')) return '实验执行中'
  if (campaign.attempts.some((attempt) => attempt.status === 'unknown')) return '实验状态待核对'
  if (campaign.attempts.some((attempt) => attempt.status === 'completed'))
    return '实验结果已核验 · 待独立复核'
  return `${stageLabels[campaign.stage]} · ${statusLabels[campaign.status]}`
}

export function ResearchCampaignPanel() {
  const [approvalChannel, setApprovalChannel] = createSignal<string | null>(null)
  const [templateCatalog, setTemplateCatalog] = createSignal<
    Array<{ id: string; inputHash: string; codeHash: string }>
  >([])
  const [executionBackends, setExecutionBackends] = createSignal<
    Array<{ id: string; backendPolicyHash: string | null; trackingPolicyHash: string | null }>
  >([])
  const [executionDevice, setExecutionDevice] = createSignal('')
  const scope = createMemo(() => {
    const workspaceId = workspace()?.id
    const conversationId = state.activeConversation
    return workspaceId && conversationId ? { workspaceId, conversationId } : undefined
  })
  const scopeKey = () => `${scope()?.workspaceId ?? ''}:${scope()?.conversationId ?? ''}`
  const source = createMemo(() => {
    const selected = scope()
    return selected
      ? {
          ...selected,
          revision: researchRefreshVersion(selected.workspaceId, selected.conversationId),
        }
      : undefined
  })
  const [campaigns, { refetch }] = createResource(source, async (selected) => {
    const result = await client.api<{
      campaigns: ResearchCampaign[]
      approvalUrl?: string | null
      templates?: Array<{ id: string; inputHash: string; codeHash: string }>
      executionBackends?: Array<{
        id: string
        backendPolicyHash: string | null
        trackingPolicyHash: string | null
      }>
    }>(
      `/api/research/campaigns?ws=${encodeURIComponent(selected.workspaceId)}&conversationId=${encodeURIComponent(selected.conversationId)}`,
    )
    setApprovalChannel(result.approvalUrl ?? null)
    setTemplateCatalog(result.templates ?? [])
    setExecutionBackends(result.executionBackends ?? [])
    return result.campaigns
  })
  const [goal, setGoal] = createSignal('')
  const [doi, setDoi] = createSignal('')
  const [pmid, setPmid] = createSignal('')
  const [reviewQuote, setReviewQuote] = createSignal<{
    campaignId: string
    quote: {
      evidencePackHash: string
      configHash: string
      artifactVersionIds: string[]
      reservedCost: number
      currency: string
      maxRequests: number
      maxOutputTokens: number
    }
  }>()
  const [operation, setOperation] = createSignal<{ scope: string; id: string }>()
  const [notice, setNotice] = createSignal<{ scope: string; text: string }>()
  const pending = new Map<string, string>()
  const busy = () => operation()?.scope === scopeKey()
  const message = () => (notice()?.scope === scopeKey() ? notice()?.text : '')
  createEffect(on(scopeKey, () => setGoal('')))
  async function act(work: () => Promise<void>, success: string) {
    const current = { scope: scopeKey(), id: crypto.randomUUID() }
    setOperation(current)
    setNotice(undefined)
    try {
      await work()
      if (scopeKey() === current.scope) {
        setNotice({ scope: current.scope, text: success })
        await refetch()
      }
    } catch (error) {
      if (scopeKey() === current.scope)
        setNotice({
          scope: current.scope,
          text: explainApiError(error, '操作失败，请刷新后重试。'),
        })
    } finally {
      if (operation()?.id === current.id) setOperation(undefined)
    }
  }
  async function create() {
    const selected = scope()
    const value = goal().trim()
    if (!selected || !value || busy()) return
    const key = `${scopeKey()}:${value}`
    if (!pending.has(key)) pending.set(key, crypto.randomUUID())
    await act(async () => {
      await client.api<ResearchWriteResult>(
        `/api/research/campaigns?ws=${encodeURIComponent(selected.workspaceId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            parentConversationId: selected.conversationId,
            goal: value,
            idempotencyKey: pending.get(key),
          }),
        },
      )
      pending.delete(key)
      if (
        scope()?.conversationId === selected.conversationId &&
        scope()?.workspaceId === selected.workspaceId
      )
        setGoal('')
    }, '研究提案已保存。尚未授权执行。')
  }
  async function runTemplate(campaign: ResearchCampaign, templateId: ResearchTemplateId) {
    if (busy()) return
    if (approvalChannel() || templateId === 'supervised-phantom-v2') {
      await approveAndRun(campaign, templateId)
      return
    }
    const key = `synthetic:${campaign.id}:${templateId}`
    if (!pending.has(key)) pending.set(key, crypto.randomUUID())
    await act(async () => {
      await client.api(
        `/api/research/campaigns/${campaign.id}/synthetic?accepted=true&ws=${encodeURIComponent(campaign.workspaceId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: campaign.version,
            dispatchKey: pending.get(key),
            templateId,
          }),
        },
      )
      pending.delete(key)
    }, '固定模板请求已登记；以尝试和产物核验结果为准。')
  }
  async function approveAndRun(campaign: ResearchCampaign, templateId: ResearchTemplateId) {
    const approvalUrl = approvalChannel()
    if (!approvalUrl) {
      setNotice({ scope: scopeKey(), text: '请先配置独立审批渠道，再启动真实训练。' })
      return
    }
    const template = templateCatalog().find((item) => item.id === templateId)
    if (!template) return
    const device =
      executionBackends().find((item) => item.id === executionDevice()) ?? executionBackends()[0]
    if (templateId === 'supervised-phantom-v2' && !device) {
      setNotice({
        scope: scopeKey(),
        text: '尚未配置研究执行守护进程。SSH 登录与 CLI 探测不等于执行设备准入。',
      })
      return
    }
    const popup = window.open('about:blank', 'oph-research-approval')
    if (!popup) {
      setNotice({ scope: scopeKey(), text: '请允许打开独立审批窗口。' })
      return
    }
    await act(async () => {
      try {
        const key = crypto.randomUUID()
        const endpoint = `/api/research/campaigns/${campaign.id}`
        const suffix = `?ws=${encodeURIComponent(campaign.workspaceId)}`
        const declared = await client.api<{ campaign: ResearchCampaign }>(
          `${endpoint}/proposals${suffix}`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedVersion: campaign.version,
              idempotencyKey: `declare-${key}`,
              command: {
                kind: 'declareSyntheticTask',
                taskId: `experiment-${key}`,
                templateId,
                inputHash: template.inputHash,
                artifactVersionIds: [],
              },
            }),
          },
        )
        const current = declared.campaign
        const task = current.taskRevisions.find((item) => item.taskId === `experiment-${key}`)!
        const body = {
          expectedVersion: current.version,
          idempotencyKey: `approve-${key}`,
          bundleHash: current.bundleHash,
          scope: {
            kind: 'execution',
            ...(templateId === 'supervised-phantom-v2'
              ? {
                  executionLimits: {
                    maxRuntimeMs: 600_000,
                    cpu: 1,
                    memoryMb: 256,
                    codeHash: template.codeHash,
                    inputHash: template.inputHash,
                  },
                }
              : {}),
            taskRevisionId: task.id,
            dispatchKey: key,
            artifactVersionIds: task.artifactVersionIds ?? [],
            currency: current.budget.currency,
            maxCost: current.budget.limit,
            expiresAt: Date.now() + 15 * 60_000,
            ...(device?.backendPolicyHash ? { backendPolicyHash: device.backendPolicyHash } : {}),
            ...(device?.trackingPolicyHash
              ? { trackingPolicyHash: device.trackingPolicyHash }
              : {}),
          },
        }
        const proof = await requestHumanApproval(
          approvalUrl,
          {
            workspaceId: current.workspaceId,
            campaignId: current.id,
            action: 'approve',
            body,
            display: {
              title: current.goal,
              task: templateName(templateId),
              revision: task.revision,
            },
          },
          popup,
        )
        const approved = await client.api<{ campaign: ResearchCampaign }>(
          `${endpoint}/approve${suffix}`,
          { method: 'POST', headers: { 'x-oph-human-proof': proof }, body: JSON.stringify(body) },
        )
        const approval = approved.campaign.approvals.find(
          (item) => item.scope?.dispatchKey === key,
        )!
        await client.api(`${endpoint}/synthetic${suffix}&accepted=true`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: approved.campaign.version,
            dispatchKey: key,
            templateId,
            taskRevisionId: task.id,
            approvalId: approval.id,
          }),
        })
      } finally {
        popup.close()
      }
    }, '已签署任务并提交执行；完成状态以产物核验为准。')
  }
  async function cancel(campaign: ResearchCampaign, attemptId: string) {
    await act(
      () =>
        client
          .api(
            `/api/research/campaigns/${campaign.id}/synthetic/cancel?ws=${encodeURIComponent(campaign.workspaceId)}`,
            { method: 'POST', body: JSON.stringify({ attemptId }) },
          )
          .then(() => undefined),
      '取消请求已记录；等待执行者确认后才会显示已取消。',
    )
  }
  async function reconcile(campaign: ResearchCampaign, attemptId: string) {
    await act(
      () =>
        client
          .api(
            `/api/research/campaigns/${campaign.id}/synthetic/reconcile?ws=${encodeURIComponent(campaign.workspaceId)}`,
            { method: 'POST', body: JSON.stringify({ attemptId }) },
          )
          .then(() => undefined),
      '已请求核对状态；不会自动重试。',
    )
  }
  async function literature(campaign: ResearchCampaign) {
    const submittedDoi = doi().trim()
    const submittedPmid = pmid().trim()
    if (busy() || Boolean(submittedDoi) === Boolean(submittedPmid)) return
    await act(async () => {
      await client.api(
        `/api/research/campaigns/${campaign.id}/literature?ws=${encodeURIComponent(campaign.workspaceId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: campaign.version,
            idempotencyKey: crypto.randomUUID(),
            ...(submittedDoi ? { doi: submittedDoi } : { pmid: submittedPmid }),
          }),
        },
      )
      setDoi('')
      setPmid('')
    }, '已登记公开文献元数据；不包含全文。')
  }
  function completedAttemptIds(campaign: ResearchCampaign) {
    return (campaign.attempts ?? [])
      .filter((attempt) => attempt.status === 'completed')
      .map((attempt) => attempt.id)
  }
  async function quoteReview(campaign: ResearchCampaign) {
    const attemptIds = completedAttemptIds(campaign)
    if (busy() || attemptIds.length === 0) return
    await act(async () => {
      const result = await client.api<{
        quote: {
          evidencePackHash: string
          configHash: string
          artifactVersionIds: string[]
          reservedCost: number
          currency: string
          maxRequests: number
          maxOutputTokens: number
        }
      }>(
        `/api/research/campaigns/${campaign.id}/review/quote?ws=${encodeURIComponent(campaign.workspaceId)}`,
        { method: 'POST', body: JSON.stringify({ attemptIds }) },
      )
      setReviewQuote({ campaignId: campaign.id, quote: result.quote })
    }, '已生成审阅报价；仍需外部签名审批。')
  }
  function reviewApproval(campaign: ResearchCampaign) {
    const selected = reviewQuote()
    if (!selected || selected.campaignId !== campaign.id) return undefined
    const quote = selected.quote
    return campaign.approvals.find(
      (approval) =>
        approval.status === 'active' &&
        !approval.consumedBy &&
        approval.scope?.kind === 'model_review' &&
        approval.scope.evidencePackHash === quote.evidencePackHash &&
        approval.scope.configHash === quote.configHash &&
        approval.scope.maxRequests === quote.maxRequests &&
        approval.scope.maxOutputTokens === quote.maxOutputTokens &&
        approval.scope.currency === quote.currency &&
        approval.scope.maxCost >= quote.reservedCost &&
        typeof approval.scope.dispatchKey === 'string' &&
        approval.scope.expiresAt > Date.now() &&
        [...approval.scope.artifactVersionIds].sort().join(',') ===
          [...quote.artifactVersionIds].sort().join(','),
    )
  }
  async function executeReview(campaign: ResearchCampaign) {
    const quote = reviewQuote()?.campaignId === campaign.id ? reviewQuote()!.quote : undefined
    const approval = reviewApproval(campaign)
    if (!quote || !approval || busy()) return
    await act(
      () =>
        client
          .api(
            `/api/research/campaigns/${campaign.id}/review?ws=${encodeURIComponent(campaign.workspaceId)}`,
            {
              method: 'POST',
              body: JSON.stringify({
                attemptIds: completedAttemptIds(campaign),
                expectedVersion: campaign.version,
                dispatchKey: approval.scope!.dispatchKey,
                approvalId: approval.id,
              }),
            },
          )
          .then(() => undefined),
      '独立模型审阅已提交；仅输出与产物版本绑定的主张。',
    )
  }
  return (
    <section
      class="research-stage-card research-campaign-panel"
      aria-label="科研提案账本"
      aria-busy={busy() || campaigns.loading}
    >
      <h3>科研提案账本</h3>
      <p>
        {approvalChannel()
          ? '执行前将在独立审批窗口核对并签署本次任务。'
          : '尚未配置独立审批渠道。真实训练需要任务绑定的人类批准。'}
      </p>
      <Show when={executionBackends().length > 0}>
        <label>
          执行设备{' '}
          <select
            value={executionDevice()}
            onChange={(event) => setExecutionDevice(event.currentTarget.value)}
          >
            <For each={executionBackends()}>
              {(device) => <option value={device.id}>{device.id}</option>}
            </For>
          </select>
        </label>
      </Show>
      <Show when={scope()} fallback={<p>请先打开一个会话，再创建研究提案。</p>}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <label for="research-campaign-goal">研究目标</label>
          <input
            id="research-campaign-goal"
            value={goal()}
            onInput={(event) => setGoal(event.currentTarget.value)}
            disabled={busy()}
            required
          />
          <button type="submit" disabled={busy() || !goal().trim()}>
            {busy() ? '保存中…' : '保存提案'}
          </button>
          <button
            type="button"
            disabled={busy() || campaigns.loading}
            onClick={() => void refetch()}
          >
            刷新账本
          </button>
        </form>
        <output aria-live="polite">{message()}</output>
        <Show when={campaigns.error}>
          <p role="alert">账本读取失败，请刷新重试。</p>
        </Show>
        <Show when={!campaigns.loading && !campaigns.error && campaigns()?.length === 0}>
          <p>此会话尚无科研提案。</p>
        </Show>
        <For each={campaigns.error || campaigns.loading ? [] : campaigns()}>
          {(campaign) => (
            <article>
              <h4>{campaign.goal}</h4>
              <p>
                {campaignProgress(campaign)} · 账本版本 {campaign.version}
              </p>
              <fieldset>
                <legend>可复现实验（仅合成数据）</legend>
                <For each={templates}>
                  {(template) => (
                    <button
                      type="button"
                      disabled={
                        busy() ||
                        (campaign.attempts ?? []).some((attempt) => attempt.status === 'running')
                      }
                      onClick={() => void runTemplate(campaign, template.id)}
                    >
                      {approvalChannel() || template.id === 'supervised-phantom-v2'
                        ? '审批后运行：'
                        : '运行：'}
                      {template.label}
                    </button>
                  )}
                </For>
              </fieldset>
              <ResearchPatternPanel campaign={campaign} busy={busy()} act={act} />
              <fieldset>
                <legend>公开文献元数据</legend>
                <label for={`research-doi-${campaign.id}`}>DOI</label>
                <input
                  id={`research-doi-${campaign.id}`}
                  value={doi()}
                  onInput={(event) => setDoi(event.currentTarget.value)}
                  disabled={busy() || Boolean(pmid())}
                />
                <label for={`research-pmid-${campaign.id}`}>PMID</label>
                <input
                  id={`research-pmid-${campaign.id}`}
                  value={pmid()}
                  onInput={(event) => setPmid(event.currentTarget.value)}
                  disabled={busy() || Boolean(doi())}
                  inputmode="numeric"
                />
                <button
                  type="button"
                  disabled={busy() || Boolean(doi().trim()) === Boolean(pmid().trim())}
                  onClick={() => void literature(campaign)}
                >
                  查公开文献
                </button>
                <p>仅登记公开元数据，不读取或展示全文。</p>
                <For each={campaign.literatureCitations ?? []}>
                  {(citation) => (
                    <p>
                      《{citation.title}》 · {citation.doi ?? citation.pmid} · 发表{' '}
                      {citation.publishedAt ?? '未提供'} · 检索{' '}
                      {new Date(citation.retrievedAt).toLocaleString()} ·{' '}
                      <a href={citation.url} target="_blank" rel="noreferrer">
                        查看公开记录
                      </a>
                    </p>
                  )}
                </For>
              </fieldset>
              <section aria-label="不可变任务谱系">
                <h5>任务修订</h5>
                <For each={campaign.taskRevisions ?? []}>
                  {(task) => (
                    <p>
                      {templateName(task.templateId)} · 修订 {task.revision} ·{' '}
                      {task.stageId
                        ? `${executionLabels[task.stageId]} → ${stageLabels[executionStageMap[task.stageId]]}`
                        : '未声明执行阶段'}{' '}
                      · {taskStatuses[task.status]} · 依赖产物{' '}
                      {task.artifactVersionIds?.length ?? 0} 项
                    </p>
                  )}
                </For>
              </section>
              <section aria-label="尝试谱系">
                <h5>尝试</h5>
                <For each={campaign.attempts ?? []}>
                  {(attempt, index) => (
                    <div>
                      <p>
                        第 {index() + 1} 次运行 ·{' '}
                        {templateName(
                          campaign.taskRevisions.find((task) => task.id === attempt.taskRevisionId)
                            ?.templateId ?? '',
                        )}{' '}
                        ·{' '}
                        {attempt.cancelRequestedAt && attempt.status === 'running'
                          ? '取消请求中，等待执行者确认'
                          : attemptLabels[attempt.status]}{' '}
                        · {attempt.backend ? backendLabels[attempt.backend] : '本地执行后端未声明'}
                      </p>
                      <Show when={attempt.error}>
                        <p role="alert">{attempt.error}</p>
                      </Show>
                      <Show when={attempt.status === 'completed' && attempt.jobSpec?.version === 2}>
                        <ResearchExperimentResult
                          campaignId={campaign.id}
                          workspaceId={campaign.workspaceId}
                          attemptId={attempt.id}
                        />
                      </Show>
                      <Show when={attempt.status === 'running' && !attempt.cancelRequestedAt}>
                        <button type="button" onClick={() => void cancel(campaign, attempt.id)}>
                          请求取消
                        </button>
                      </Show>
                      <Show when={attempt.status === 'unknown'}>
                        <button type="button" onClick={() => void reconcile(campaign, attempt.id)}>
                          核对状态
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </section>
              <section aria-label="产物核验">
                <h5>产物版本</h5>
                <For each={campaign.artifactVersions}>
                  {(artifact) => (
                    <p>
                      {templateName(artifact.schemaId ?? '')}结果 · 版本 {artifact.version} ·{' '}
                      {artifact.dataClass === 'synthetic'
                        ? '合成数据'
                        : artifact.dataClass === 'public'
                          ? '公开数据'
                          : '研究数据'}{' '}
                      ·{' '}
                      {artifact.validation
                        ? `已核验（${(artifact.validation.byteLength / 1024).toFixed(1)} KB）`
                        : '未提供核验元数据'}{' '}
                      · 来源：{runName(campaign, artifact.producerAttemptId)}
                    </p>
                  )}
                </For>
              </section>
              <section aria-label="审批事实">
                <h5>审批</h5>
                <For each={campaign.approvals}>
                  {(approval) => (
                    <p>
                      {approvalKinds[approval.scope?.kind ?? 'protocol']} ·{' '}
                      {approval.consumedBy
                        ? '已用于批准的任务，不再授权新运行'
                        : approval.status === 'active'
                          ? '待使用'
                          : approval.status === 'revoked'
                            ? '已撤销'
                            : '来源已更新'}{' '}
                      · 到期{' '}
                      {approval.scope?.expiresAt
                        ? new Date(approval.scope.expiresAt).toLocaleString()
                        : '未声明'}{' '}
                      ·{' '}
                      {approval.consumedBy
                        ? `已用于${approvalConsumer(campaign, approval.consumedBy)}`
                        : `当前可用：${approval.status === 'active' && (approval.scope?.expiresAt ?? 0) > Date.now() ? '是' : '否'}`}{' '}
                      · 关联产物 {approval.scope?.artifactVersionIds.length ?? 0} 项
                    </p>
                  )}
                </For>
              </section>
              <section aria-label="模型审阅">
                <h5>独立模型审阅</h5>
                <button
                  type="button"
                  disabled={busy() || completedAttemptIds(campaign).length === 0}
                  onClick={() => void quoteReview(campaign)}
                >
                  获取审阅报价
                </button>
                <Show when={reviewQuote()?.campaignId === campaign.id ? reviewQuote() : undefined}>
                  {(selected) => (
                    <div>
                      <p>
                        预留 {selected().quote.reservedCost} {selected().quote.currency} · 最多{' '}
                        {selected().quote.maxRequests} 次请求 · 每次最多{' '}
                        {selected().quote.maxOutputTokens} tokens。
                      </p>
                      <Show
                        when={reviewApproval(campaign)}
                        fallback={
                          <p>
                            没有匹配的有效签名审批。请联系已配置的身份服务；本界面不接收证明或令牌。
                          </p>
                        }
                      >
                        <button
                          type="button"
                          disabled={busy()}
                          onClick={() => void executeReview(campaign)}
                        >
                          执行已审批审阅
                        </button>
                      </Show>
                    </div>
                  )}
                </Show>
                <For each={campaign.modelReviews ?? []}>
                  {(review, index) => (
                    <details>
                      <summary>
                        第 {index() + 1} 次独立复核 ·{' '}
                        {review.executionBackend === 'builtin-cli' ? 'CLI 模型' : 'API 模型'} ·{' '}
                        {reviewStatuses[review.status]} ·{' '}
                        {review.sourceValidity === 'stale'
                          ? '证据已失效，仅供历史查看'
                          : '当前证据'}{' '}
                        · 已用 {review.requestCount}/{review.maxRequests} 次 · 实际费用{' '}
                        {review.actualCost === null || review.actualCost === undefined
                          ? '未知'
                          : `${review.actualCost} ${review.currency}`}
                      </summary>
                      <p>关联 {review.artifactVersionIds.length} 项证据产物</p>
                      <Show when={review.text}>
                        <pre>{readableReview(review.text!)}</pre>
                      </Show>
                    </details>
                  )}
                </For>
              </section>
              <section aria-label="标注数据引用">
                <h5>标注数据汇总</h5>
                <For each={campaign.labelSets ?? []}>
                  {(labelSet) => (
                    <p>
                      标注数据 · 版本 {labelSet.version} · 受试对象 {labelSet.aggregate.subjects} ·
                      观测 {labelSet.aggregate.observations} · 类别{' '}
                      {Object.entries(labelSet.aggregate.classes)
                        .map(([name, count]) => `${name}: ${count}`)
                        .join('、')}
                    </p>
                  )}
                </For>
              </section>
            </article>
          )}
        </For>
      </Show>
    </section>
  )
}
