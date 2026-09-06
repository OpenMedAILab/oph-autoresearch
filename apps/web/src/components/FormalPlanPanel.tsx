import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createEffect, createResource, createSignal, For, Show } from 'solid-js'
import { requestHumanApproval } from '../lib/research-approval.ts'
import { client } from '../lib/store/index.ts'

interface PlanInput {
  planId: string
  preparationId: string
  ociImageDigest: string
  dataManifestHash: string
  labelSetContentHash: string
  trustedEvaluatorId: string
  trustedEvaluatorHash: string
  maxRuntimeMs: number
  cpu: number
  memoryMb: number
  pidsLimit: number
}
interface StoredPlan
  extends Omit<PlanInput, 'preparationId' | 'maxRuntimeMs' | 'cpu' | 'memoryMb' | 'pidsLimit'> {
  resources: { maxRuntimeMs: number; cpu: number; memoryMb: number; pidsLimit: number }
  candidateArtifactId: string
}
interface FormalState {
  plans: StoredPlan[]
  reviews: Array<{ formalPlanHash: string; decision: string; findings: Array<{ message: string }> }>
  drafts: Array<{ plan: StoredPlan; preparationId: string; dispatchId: string }>
  dispatches: Array<{
    id: string
    formalPlanHash: string
    status: string
    result?: { decision: string }
  }>
  admittedBackend: boolean
  admissionReason: string
  executions: Array<{
    id: string
    planId: string
    attemptId: string | null
    status: string
    receiptHash?: string
  }>
  catalog: {
    images: Array<{ label: string; digest: string }>
    datasets: Array<{ label: string; dataManifestHash: string; labelSetContentHash: string }>
    evaluators: Array<{ id: string; label: string; implementationHash: string }>
  }
}
function fromDraft(draft: FormalState['drafts'][number]): PlanInput {
  const plan = draft.plan
  return {
    planId: plan.planId,
    preparationId: draft.preparationId,
    ociImageDigest: plan.ociImageDigest,
    dataManifestHash: plan.dataManifestHash,
    labelSetContentHash: plan.labelSetContentHash,
    trustedEvaluatorId: plan.trustedEvaluatorId,
    trustedEvaluatorHash: plan.trustedEvaluatorHash,
    maxRuntimeMs: plan.resources.maxRuntimeMs,
    cpu: plan.resources.cpu,
    memoryMb: plan.resources.memoryMb,
    pidsLimit: plan.resources.pidsLimit,
  }
}
type Pending = {
  kind: 'review' | 'freeze'
  endpoint: string
  suffix: string
  campaignId: string
  workspaceId: string
  approvalUrl: string
  input: PlanInput
  executionMaxCost: number
  key: string
  approvalBody?: Record<string, unknown>
  proof?: string
  executionBody?: Record<string, unknown>
}

/** The browser selects administrator-labelled options; host paths and digests are never editable. */
export function FormalPlanPanel(props: {
  campaign: ResearchCampaign
  approvalUrl: string | null
  busy: boolean
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const [state, { refetch }] = createResource(
    () => [props.campaign.id, props.campaign.workspaceId, props.campaign.version] as const,
    async ([id, workspaceId]) => {
      const value = await client.api<FormalState>(
        `/api/research/campaigns/${id}/formal-execution?ws=${encodeURIComponent(workspaceId)}`,
      )
      if (
        !Array.isArray(value.plans) ||
        !Array.isArray(value.reviews) ||
        !Array.isArray(value.dispatches) ||
        !Array.isArray(value.catalog?.images) ||
        !Array.isArray(value.catalog?.datasets) ||
        !Array.isArray(value.catalog?.evaluators)
      )
        throw new Error('正式实验状态暂不可用')
      return {
        ...value,
        drafts: value.drafts ?? [],
        executions: value.executions ?? [],
        owner: `${workspaceId}:${id}`,
      }
    },
  )
  const current = () => {
    const value = state.error ? undefined : state()
    return value?.owner === `${props.campaign.workspaceId}:${props.campaign.id}` ? value : undefined
  }
  const [candidate, setCandidate] = createSignal('')
  const [image, setImage] = createSignal('')
  const [dataset, setDataset] = createSignal('')
  const [evaluator, setEvaluator] = createSignal('')
  const [minutes, setMinutes] = createSignal(30)
  const [cpu, setCpu] = createSignal(1)
  const [memory, setMemory] = createSignal(1024)
  const [pids, setPids] = createSignal(64)
  const [executionCost, setExecutionCost] = createSignal(1)
  const [retry, setRetry] = createSignal<Pending | null>(null)
  let project = ''
  createEffect(() => {
    const next = `${props.campaign.workspaceId}:${props.campaign.id}`
    if (next === project) return
    project = next
    setCandidate('')
    setImage('')
    setDataset('')
    setEvaluator('')
    setRetry(null)
  })
  const candidates = () =>
    (props.campaign.cliPreparations ?? []).filter((item) => item.status === 'candidate')
  const configured = () =>
    Boolean(
      current()?.catalog.images.length &&
        current()?.catalog.datasets.length &&
        current()?.catalog.evaluators.length,
    )
  const validResources = () =>
    [minutes(), cpu(), memory(), pids()].every(Number.isSafeInteger) &&
    minutes() >= 1 &&
    minutes() <= 1440 &&
    cpu() >= 1 &&
    cpu() <= 256 &&
    memory() >= 128 &&
    memory() <= 1048576 &&
    pids() >= 1 &&
    pids() <= 65536
  function newPlan(): PlanInput | null {
    const values = current()?.catalog
    const chosen = candidates().find((item) => item.id === candidate())
    const selectedImage = values?.images.find((item) => item.digest === image())
    const selectedDataset = values?.datasets.find((item) => item.dataManifestHash === dataset())
    const selectedEvaluator = values?.evaluators.find((item) => item.id === evaluator())
    if (!chosen || !selectedImage || !selectedDataset || !selectedEvaluator || !validResources())
      return null
    return {
      planId: `fp_${crypto.randomUUID()}`,
      preparationId: chosen.id,
      ociImageDigest: selectedImage.digest,
      dataManifestHash: selectedDataset.dataManifestHash,
      labelSetContentHash: selectedDataset.labelSetContentHash,
      trustedEvaluatorId: selectedEvaluator.id,
      trustedEvaluatorHash: selectedEvaluator.implementationHash,
      maxRuntimeMs: minutes() * 60000,
      cpu: cpu(),
      memoryMb: memory(),
      pidsLimit: pids(),
    }
  }
  const draftDispatch = (draft: FormalState['drafts'][number]) =>
    current()?.dispatches.find((item) => item.id === draft.dispatchId)
  const accepted = (draft: FormalState['drafts'][number]) => {
    const dispatch = draftDispatch(draft)
    return current()?.reviews.some(
      (item) => item.formalPlanHash === dispatch?.formalPlanHash && item.decision === 'accepted',
    )
  }
  function begin(kind: Pending['kind'], input: PlanInput) {
    if (!props.approvalUrl) return
    return perform({
      kind,
      input,
      campaignId: props.campaign.id,
      workspaceId: props.campaign.workspaceId,
      endpoint: `/api/research/campaigns/${props.campaign.id}`,
      suffix: `?ws=${encodeURIComponent(props.campaign.workspaceId)}`,
      approvalUrl: props.approvalUrl,
      key: crypto.randomUUID(),
      executionMaxCost: executionCost(),
    })
  }
  function perform(pending: Pending) {
    const popup = pending.proof ? null : window.open('about:blank', 'oph-research-approval')
    setRetry(pending)
    return props.act(
      async () => {
        try {
          const post = <T,>(action: string, body: unknown, proof?: string) =>
            client.api<T>(`${pending.endpoint}/${action}${pending.suffix}`, {
              method: 'POST',
              body: JSON.stringify(body),
              ...(proof ? { headers: { 'x-oph-human-proof': proof } } : {}),
            })
          if (!pending.approvalBody) {
            const latest = await client.api<{ campaign: ResearchCampaign }>(
              `${pending.endpoint}${pending.suffix}`,
            )
            const quote = await post<{
              reviewApprovalScope?: unknown
              formalExecutionApprovalScope?: unknown
            }>(`formal-execution/${pending.kind === 'review' ? 'quote' : 'approval'}`, {
              ...pending.input,
              expiresAt: Date.now() + 15 * 60000,
              ...(pending.kind === 'freeze' ? { executionMaxCost: pending.executionMaxCost } : {}),
            })
            const scope =
              pending.kind === 'review'
                ? quote.reviewApprovalScope
                : quote.formalExecutionApprovalScope
            if (!scope) throw new Error('正式实验审批范围暂不可用')
            pending.approvalBody = {
              expectedVersion: latest.campaign.version,
              bundleHash: latest.campaign.bundleHash,
              idempotencyKey: `formal-approve:${pending.key}`,
              approvalId: `fap_${pending.key}`,
              scope,
            }
          }
          if (!pending.proof) {
            if (!popup) throw new Error('请允许独立审批窗口')
            pending.proof = await requestHumanApproval(
              pending.approvalUrl,
              {
                workspaceId: pending.workspaceId,
                campaignId: pending.campaignId,
                action: 'approve',
                body: pending.approvalBody,
              },
              popup,
            )
          }
          if (!pending.executionBody) {
            const approved = await post<{ campaign: ResearchCampaign }>(
              'approve',
              pending.approvalBody,
              pending.proof,
            )
            pending.executionBody = {
              ...pending.input,
              approvalId: pending.approvalBody.approvalId,
              expectedVersion: approved.campaign.version,
              idempotencyKey: `formal-${pending.kind}:${pending.key}`,
            }
          }
          await post(`formal-execution/${pending.kind}`, pending.executionBody)
          if (
            props.campaign.id === pending.campaignId &&
            props.campaign.workspaceId === pending.workspaceId
          ) {
            setRetry(null)
            await refetch()
          }
        } finally {
          popup?.close()
        }
      },
      pending.kind === 'review'
        ? '代码审阅请求已记录，请查看最新审阅状态。'
        : '正式实验计划已冻结；实际执行仍取决于后端准入。',
    )
  }
  async function submit(plan: StoredPlan) {
    const campaign = props.campaign
    await props.act(async () => {
      await client.api(
        `/api/research/campaigns/${campaign.id}/formal-execution/submit?ws=${encodeURIComponent(campaign.workspaceId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            planId: plan.planId,
            expectedVersion: campaign.version,
            idempotencyKey: `formal-submit:${plan.planId}`,
          }),
        },
      )
      if (props.campaign.id === campaign.id) await refetch()
    }, '正式执行请求已提交。')
  }
  const executionAttempt = (item: FormalState['executions'][number]) =>
    props.campaign.attempts?.find((attempt) => attempt.id === item.attemptId)
  const activeExecution = (item: FormalState['executions'][number]) => {
    const status = executionAttempt(item)?.status ?? item.status
    return ['reserved', 'bound', 'running', 'unknown'].includes(status)
  }
  const executionLabel = (item: FormalState['executions'][number]) => {
    const attempt = executionAttempt(item)
    if (attempt?.resultDisposition === 'quarantined') return '迟到结果已隔离，不能作为正式成果'
    if (attempt?.cancelRequestedAt && activeExecution(item)) return '已请求取消，等待确认实际停止'
    const status = attempt?.status ?? item.status
    return (
      (
        {
          reserved: '等待执行',
          bound: '等待执行端确认',
          running: '执行中',
          unknown: '状态待核对，不会重新投递',
          completed: '执行已完成',
          failed: '执行失败',
          cancelled: '已确认取消',
        } as Record<string, string>
      )[status] ?? '执行状态待确认'
    )
  }
  const verifiedReceipt = (item: FormalState['executions'][number]) => {
    const attempt = executionAttempt(item)
    if (
      attempt?.status !== 'completed' ||
      attempt.resultDisposition === 'quarantined' ||
      !item.receiptHash
    )
      return false
    return (
      props.campaign.artifactVersions?.some(
        (artifact) =>
          artifact.id === attempt.artifactVersionId &&
          artifact.producerAttemptId === attempt.id &&
          artifact.kind === 'formal_execution_receipt' &&
          artifact.schemaId === 'research-formal-oci-receipt-v1' &&
          artifact.contentHash === item.receiptHash,
      ) ?? false
    )
  }
  async function controlExecution(action: 'cancel' | 'reconcile', attemptId: string) {
    const campaign = props.campaign
    await props.act(
      async () => {
        await client.api(
          `/api/research/campaigns/${campaign.id}/formal-execution/${action}?ws=${encodeURIComponent(campaign.workspaceId)}`,
          {
            method: 'POST',
            body: JSON.stringify({ attemptId }),
          },
        )
        if (
          props.campaign.id === campaign.id &&
          props.campaign.workspaceId === campaign.workspaceId
        )
          await refetch()
      },
      action === 'cancel'
        ? '已请求取消，实际停止状态以执行端确认结果为准。'
        : '已请求核对原任务，不会重新提交实验。',
    )
  }
  return (
    <details>
      <summary>正式实验计划</summary>
      <Show when={state.error}>
        <p role="alert">正式实验状态加载失败，请重试。</p>
      </Show>
      <button type="button" disabled={props.busy || state.loading} onClick={() => void refetch()}>
        刷新正式实验状态
      </button>
      <Show when={current()}>
        {(value) => (
          <>
            <p>
              {value().admittedBackend ? '正式执行环境已准入' : '正式执行环境尚未准入'}：
              {value().admissionReason}
            </p>
            <p>候选代码须先独立审阅，再批准并冻结完整计划。冻结不会直接启动实验。</p>
            <Show when={!configured()}>
              <p>请先配置正式实验的运行镜像、数据集和评估器，配置完成后可选择计划。</p>
            </Show>
            <Show when={configured()}>
              <label>
                候选代码
                <select
                  value={candidate()}
                  onChange={(event) => setCandidate(event.currentTarget.value)}
                >
                  <option value="">选择候选代码</option>
                  <For each={candidates()}>
                    {(item, index) => <option value={item.id}>候选代码 {index() + 1}</option>}
                  </For>
                </select>
              </label>
              <label>
                运行镜像
                <select value={image()} onChange={(event) => setImage(event.currentTarget.value)}>
                  <option value="">选择运行镜像</option>
                  <For each={value().catalog.images}>
                    {(item) => <option value={item.digest}>{item.label}</option>}
                  </For>
                </select>
              </label>
              <label>
                实验数据
                <select
                  value={dataset()}
                  onChange={(event) => setDataset(event.currentTarget.value)}
                >
                  <option value="">选择实验数据</option>
                  <For each={value().catalog.datasets}>
                    {(item) => <option value={item.dataManifestHash}>{item.label}</option>}
                  </For>
                </select>
              </label>
              <label>
                独立评估器
                <select
                  value={evaluator()}
                  onChange={(event) => setEvaluator(event.currentTarget.value)}
                >
                  <option value="">选择独立评估器</option>
                  <For each={value().catalog.evaluators}>
                    {(item) => <option value={item.id}>{item.label}</option>}
                  </For>
                </select>
              </label>
              <label>
                最长运行分钟
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={minutes()}
                  onInput={(event) => setMinutes(Number(event.currentTarget.value))}
                />
              </label>
              <label>
                CPU 核数
                <input
                  type="number"
                  min="1"
                  max="256"
                  value={cpu()}
                  onInput={(event) => setCpu(Number(event.currentTarget.value))}
                />
              </label>
              <label>
                内存上限（MB）
                <input
                  type="number"
                  min="128"
                  max="1048576"
                  value={memory()}
                  onInput={(event) => setMemory(Number(event.currentTarget.value))}
                />
              </label>
              <label>
                进程数上限
                <input
                  type="number"
                  min="1"
                  max="65536"
                  value={pids()}
                  onInput={(event) => setPids(Number(event.currentTarget.value))}
                />
              </label>
              <p>实验网络关闭；数据只读，结果写入单独的输出目录。</p>
              <button
                type="button"
                disabled={
                  props.busy ||
                  !props.approvalUrl ||
                  !candidate() ||
                  !image() ||
                  !dataset() ||
                  !evaluator() ||
                  !validResources() ||
                  Boolean(retry())
                }
                onClick={() => {
                  const input = newPlan()
                  if (input) void begin('review', input)
                }}
              >
                独立批准并审阅候选代码
              </button>
            </Show>
            <Show when={!candidates().length}>
              <p>尚无可审阅的候选代码。</p>
            </Show>
            <Show when={retry()}>
              {(pending) => (
                <p>
                  上次操作尚未确认。
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => void perform(pending())}
                  >
                    查询或继续上次操作
                  </button>
                </p>
              )}
            </Show>
            <label>
              执行费用上限（{props.campaign.budget.currency}）
              <input
                type="number"
                min="0"
                step="0.01"
                value={executionCost()}
                onInput={(event) => setExecutionCost(Number(event.currentTarget.value))}
              />
            </label>
            <For each={value().reviews}>
              {(review, index) => (
                <article>
                  <p>
                    代码审阅 {index() + 1} ·{' '}
                    {review.decision === 'accepted'
                      ? '通过'
                      : review.decision === 'needs_changes'
                        ? '需要修改'
                        : '未通过'}
                  </p>
                  <For each={review.findings}>{(finding) => <p>{finding.message}</p>}</For>
                </article>
              )}
            </For>
            <For each={value().executions}>
              {(execution, index) => (
                <article>
                  <p>
                    第 {index() + 1} 次正式执行 · {executionLabel(execution)}
                  </p>
                  <Show when={verifiedReceipt(execution)}>
                    <p>执行回执已核验并归档，科研结论仍需独立结果复核。</p>
                  </Show>
                  <Show
                    when={
                      (executionAttempt(execution)?.status ?? execution.status) === 'completed' &&
                      !verifiedReceipt(execution)
                    }
                  >
                    <p>执行回执尚未核验，不能作为已验证结果。</p>
                  </Show>
                  <Show when={execution.attemptId && activeExecution(execution)}>
                    <button
                      type="button"
                      disabled={
                        props.busy || Boolean(executionAttempt(execution)?.cancelRequestedAt)
                      }
                      onClick={() => void controlExecution('cancel', execution.attemptId!)}
                    >
                      请求取消正式执行
                    </button>
                    <button
                      type="button"
                      disabled={props.busy}
                      onClick={() => void controlExecution('reconcile', execution.attemptId!)}
                    >
                      核对正式执行状态
                    </button>
                  </Show>
                </article>
              )}
            </For>
            <For each={value().drafts}>
              {(draft, index) => (
                <article>
                  <p>
                    实验草案 {index() + 1} · {draft.plan.resources.maxRuntimeMs / 60000} 分钟 ·{' '}
                    {draft.plan.resources.cpu} 核 · {draft.plan.resources.memoryMb} MB
                  </p>
                  <p>
                    {accepted(draft)
                      ? '独立代码审阅通过'
                      : draftDispatch(draft)?.status === 'done'
                        ? '审阅未通过，请修改候选代码'
                        : '审阅尚未确认，请刷新查看；不会自动重发模型请求。'}
                  </p>
                  <Show when={!value().plans.some((plan) => plan.planId === draft.plan.planId)}>
                    <button
                      type="button"
                      disabled={
                        props.busy ||
                        !props.approvalUrl ||
                        !accepted(draft) ||
                        Boolean(retry()) ||
                        !Number.isFinite(executionCost()) ||
                        executionCost() < 0
                      }
                      onClick={() => void begin('freeze', fromDraft(draft))}
                    >
                      独立批准并冻结计划
                    </button>
                  </Show>
                </article>
              )}
            </For>
            <For each={value().plans}>
              {(plan, index) => (
                <article>
                  <p>
                    已冻结计划 {index() + 1} · {plan.resources.maxRuntimeMs / 60000} 分钟 ·{' '}
                    {plan.resources.cpu} 核 · {plan.resources.memoryMb} MB
                  </p>
                  <Show
                    when={!value().executions.some((execution) => execution.planId === plan.planId)}
                  >
                    <button
                      type="button"
                      disabled={props.busy || !value().admittedBackend}
                      onClick={() => void submit(plan)}
                    >
                      提交正式实验
                    </button>
                  </Show>
                </article>
              )}
            </For>
          </>
        )}
      </Show>
    </details>
  )
}
