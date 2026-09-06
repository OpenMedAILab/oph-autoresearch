import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { requestHumanApproval } from '../lib/research-approval.ts'
import { client } from '../lib/store/index.ts'

type Route = { id: string; label: string; model: string }
export function ResearchCliPreparationPanel(props: {
  campaign: ResearchCampaign
  approvalUrl: string | null
  busy: boolean
  taskName: (template: string) => string
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const endpoint = () => `/api/research/campaigns/${props.campaign.id}/cli-preparations`
  const suffix = () => `?ws=${encodeURIComponent(props.campaign.workspaceId)}`
  const [catalog] = createResource(
    () => props.campaign.id,
    async () => {
      const value = await client.api<{ routes: Route[] }>(`${endpoint()}/catalog${suffix()}`)
      if (!Array.isArray(value.routes)) throw new Error('Invalid preparation catalog')
      return value.routes
    },
  )
  const routes = () => (catalog.error ? [] : (catalog() ?? []))
  const [routeId, setRouteId] = createSignal('')
  const [taskId, setTaskId] = createSignal('')
  const [instructions, setInstructions] = createSignal('')
  const [minutes, setMinutes] = createSignal('5')
  const [reservation, setReservation] = createSignal('1')
  const [budget, setBudget] = createSignal(String(props.campaign.budget?.limit ?? 0))
  const [acknowledged, setAcknowledged] = createSignal(false)
  let intentKey = crypto.randomUUID()
  const ready = () =>
    !props.busy &&
    props.approvalUrl &&
    routeId() &&
    taskId() &&
    instructions().trim() &&
    acknowledged() &&
    Number(minutes()) > 0 &&
    Number(minutes()) <= 10 &&
    Number(reservation()) > 0 &&
    Number(reservation()) <= (props.campaign.budget?.limit ?? 0)
  async function prepare() {
    if (!ready()) return
    const popup = window.open('about:blank', 'oph-research-approval')
    if (!popup) {
      await props.act(async () => {
        throw new Error('请允许打开独立审批窗口。')
      }, '')
      return
    }
    const captured = {
      campaignId: props.campaign.id,
      workspaceId: props.campaign.workspaceId,
      approvalUrl: props.approvalUrl!,
      endpoint: endpoint(),
      suffix: suffix(),
    }
    await props.act(async () => {
      try {
        const proposed = await client.api<{ campaign: ResearchCampaign; preparationId: string }>(
          `${captured.endpoint}/propose${captured.suffix}`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedVersion: props.campaign.version,
              idempotencyKey: intentKey,
              routeId: routeId(),
              taskRevisionId: taskId(),
              instructions: instructions().trim(),
              maxRuntimeMs: Number(minutes()) * 60000,
              maxCost: Number(reservation()),
              acknowledgeUnknownCost: true,
            }),
          },
        )
        const approval = await client.api<{
          body: { expectedVersion: number; scope: { dispatchKey: string } }
        }>(
          `${captured.endpoint}/approval${captured.suffix}&preparationId=${encodeURIComponent(proposed.preparationId)}`,
        )
        const proof = await requestHumanApproval(
          captured.approvalUrl,
          {
            workspaceId: captured.workspaceId,
            campaignId: captured.campaignId,
            action: 'approve',
            body: approval.body,
          },
          popup,
        )
        const signed = await client.api<{ campaign: ResearchCampaign }>(
          `/api/research/campaigns/${captured.campaignId}/approve${captured.suffix}`,
          {
            method: 'POST',
            headers: { 'x-oph-human-proof': proof },
            body: JSON.stringify(approval.body),
          },
        )
        const authorization = signed.campaign.approvals.find(
          (item) => item.scope?.dispatchKey === approval.body.scope.dispatchKey && !item.consumedBy,
        )
        if (!authorization) throw new Error('本次准备审批未生效')
        await client.api(`${captured.endpoint}/submit${captured.suffix}`, {
          method: 'POST',
          body: JSON.stringify({
            preparationId: proposed.preparationId,
            approvalId: authorization.id,
            expectedVersion: signed.campaign.version,
          }),
        })
        intentKey = crypto.randomUUID()
      } finally {
        popup.close()
      }
    }, '已提交远端代码准备。返回代码仅作为候选保存，正式实验需要另行冻结和批准。')
  }
  const pendingApproval = (preparationId: string) => {
    const preparation = props.campaign.cliPreparations?.find((item) => item.id === preparationId)
    return props.campaign.approvals.find(
      (item) =>
        item.status === 'active' &&
        !item.consumedBy &&
        item.bundleHash === props.campaign.bundleHash &&
        item.scope?.kind === 'cli_preparation' &&
        item.scope.dispatchKey === preparation?.dispatchKey &&
        item.scope.expiresAt > Date.now(),
    )
  }
  async function continuePreparation(preparationId: string) {
    const authorization = pendingApproval(preparationId)
    const popup = authorization ? null : window.open('about:blank', 'oph-research-approval')
    const captured = {
      campaignId: props.campaign.id,
      workspaceId: props.campaign.workspaceId,
      endpoint: endpoint(),
      suffix: suffix(),
      version: props.campaign.version,
      approvalUrl: props.approvalUrl,
    }
    await props.act(async () => {
      try {
        let approvalId = authorization?.id
        let expectedVersion = captured.version
        if (!approvalId) {
          if (!popup || !captured.approvalUrl)
            throw new Error('请配置审批渠道并允许打开独立审批窗口。')
          const quote = await client.api<{
            body: { expectedVersion: number; scope: { dispatchKey: string } }
          }>(
            `${captured.endpoint}/approval${captured.suffix}&preparationId=${encodeURIComponent(preparationId)}`,
          )
          const proof = await requestHumanApproval(
            captured.approvalUrl,
            {
              workspaceId: captured.workspaceId,
              campaignId: captured.campaignId,
              action: 'approve',
              body: quote.body,
            },
            popup,
          )
          const signed = await client.api<{ campaign: ResearchCampaign }>(
            `/api/research/campaigns/${captured.campaignId}/approve${captured.suffix}`,
            {
              method: 'POST',
              headers: { 'x-oph-human-proof': proof },
              body: JSON.stringify(quote.body),
            },
          )
          approvalId = signed.campaign.approvals.find(
            (item) =>
              item.status === 'active' &&
              item.scope?.dispatchKey === quote.body.scope.dispatchKey &&
              !item.consumedBy,
          )?.id
          expectedVersion = signed.campaign.version
          if (!approvalId) throw new Error('本次准备审批未生效')
        }
        await client.api(`${captured.endpoint}/submit${captured.suffix}`, {
          method: 'POST',
          body: JSON.stringify({ preparationId, approvalId, expectedVersion }),
        })
      } finally {
        popup?.close()
      }
    }, '已继续原代码准备；若提交响应丢失，请核对原运行，不会重新创建提案。')
  }
  async function action(attemptId: string, kind: 'cancel' | 'reconcile') {
    await props.act(
      async () => {
        await client.api(`${endpoint()}/${kind}${suffix()}`, {
          method: 'POST',
          body: JSON.stringify({ attemptId }),
        })
      },
      kind === 'cancel' ? '已请求停止，等待远端确认。' : '已核对原运行，不会重新投递。',
    )
  }
  return (
    <details>
      <summary>远端 CLI 代码准备</summary>
      <p>主控负责规划，已准入的远端 CLI 负责准备代码。候选代码不会自动用于正式实验。</p>
      <Show when={catalog.error}>
        <p role="alert">远端工具目录暂时无法读取。</p>
      </Show>
      <Show when={!catalog.loading && !catalog.error && routes().length === 0}>
        <p>尚未配置可执行的远端 CLI 工具。SSH 登录探测不代表执行准入。</p>
      </Show>
      <Show when={routes().length > 0}>
        <p>
          研究预算：{props.campaign.budget?.limit ?? 0} {props.campaign.budget?.currency ?? ''}
        </p>
        <label>
          调整研究预算
          <input
            type="number"
            min="0"
            value={budget()}
            onInput={(event) => setBudget(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={props.busy || !Number.isFinite(Number(budget())) || Number(budget()) < 0}
          onClick={() =>
            void props.act(async () => {
              await client.api(
                `/api/research/campaigns/${props.campaign.id}/proposals${suffix()}`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    expectedVersion: props.campaign.version,
                    idempotencyKey: crypto.randomUUID(),
                    command: {
                      kind: 'setBudget',
                      budget: { currency: props.campaign.budget.currency, limit: Number(budget()) },
                    },
                  }),
                },
              )
            }, '预算已更新，请重新冻结受影响的任务后发起准备。')
          }
        >
          保存预算
        </button>
        <label>
          执行工具
          <select
            value={routeId()}
            onChange={(event) => {
              setRouteId(event.currentTarget.value)
              intentKey = crypto.randomUUID()
            }}
          >
            <option value="">选择远端工具</option>
            <For each={routes()}>
              {(route) => (
                <option value={route.id}>
                  {route.label} · {route.model}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          依据任务
          <select
            value={taskId()}
            onChange={(event) => {
              setTaskId(event.currentTarget.value)
              intentKey = crypto.randomUUID()
            }}
          >
            <option value="">选择当前任务修订</option>
            <For each={props.campaign.taskRevisions.filter((task) => task.status !== 'stale')}>
              {(task) => (
                <option value={task.id}>
                  {props.taskName(task.templateId)} · 修订 {task.revision}
                </option>
              )}
            </For>
          </select>
        </label>
        <p>没有可选任务时，请先保存固定研究方案，建立当前任务修订。</p>
        <label>
          代码准备要求
          <textarea
            rows={4}
            value={instructions()}
            onInput={(event) => {
              setInstructions(event.currentTarget.value)
              intentKey = crypto.randomUUID()
            }}
          />
        </label>
        <label>
          最长运行时间（分钟）
          <input
            type="number"
            min="1"
            max="10"
            value={minutes()}
            onInput={(event) => {
              setMinutes(event.currentTarget.value)
              intentKey = crypto.randomUUID()
            }}
          />
        </label>
        <label>
          本次资金预留（{props.campaign.budget?.currency}）
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={reservation()}
            onInput={(event) => {
              setReservation(event.currentTarget.value)
              intentKey = crypto.randomUUID()
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={acknowledged()}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          />
          我确认 CLI 费用无法精确回报，预留金额不代表收费硬上限；未知费用会继续占用预留。
        </label>
        <p>
          运行时限由执行者约束。CPU 与内存为计划申请值，当前准备工具不提供操作系统资源硬限保证。
        </p>
        <button type="button" disabled={!ready()} onClick={() => void prepare()}>
          审批并准备代码
        </button>
      </Show>
      <For each={props.campaign.cliPreparations ?? []}>
        {(preparation, index) => {
          const attempt = () =>
            props.campaign.attempts.find((item) => item.id === preparation.attemptId)
          return (
            <section>
              <h5>第 {index() + 1} 次代码准备</h5>
              <p>
                {preparation.status === 'candidate'
                  ? '候选已保存 · 尚未获准正式执行'
                  : attempt()?.status === 'unknown'
                    ? '状态待核对'
                    : attempt()?.status === 'cancelled'
                      ? attempt()?.executionOutcome === 'completed'
                        ? '停止请求后的结果已隔离，不用于实验结论'
                        : '已确认停止'
                      : attempt()?.status === 'failed' || attempt()?.status === 'interrupted'
                        ? '准备未完成'
                        : preparation.status === 'claimed'
                          ? '准备中'
                          : pendingApproval(preparation.id)
                            ? '已审批 · 待提交'
                            : '待审批'}
              </p>
              <p>
                费用未知 · 预留 {preparation.maxCost} {props.campaign.budget?.currency}
              </p>
              <Show when={attempt()?.artifactVersionId}>
                <CandidateContent
                  endpoint={`${endpoint()}/candidate${suffix()}&preparationId=${encodeURIComponent(preparation.id)}`}
                />
              </Show>
              <Show when={!preparation.attemptId}>
                <p>关闭审批窗口或刷新后，可继续本次提案。</p>
                <button
                  type="button"
                  disabled={props.busy || (!pendingApproval(preparation.id) && !props.approvalUrl)}
                  onClick={() => void continuePreparation(preparation.id)}
                >
                  {pendingApproval(preparation.id) ? '提交已审批的代码准备' : '继续本次准备审批'}
                </button>
              </Show>
              <Show
                when={
                  preparation.attemptId && ['running', 'unknown'].includes(attempt()?.status ?? '')
                }
              >
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => void action(preparation.attemptId!, 'reconcile')}
                >
                  核对原运行
                </button>
                <button
                  type="button"
                  disabled={props.busy || attempt()?.cancelRequestedAt !== null}
                  onClick={() => void action(preparation.attemptId!, 'cancel')}
                >
                  请求停止准备
                </button>
              </Show>
            </section>
          )
        }}
      </For>
    </details>
  )
}

function CandidateContent(props: { endpoint: string }) {
  const [opened, setOpened] = createSignal(false)
  const [candidate] = createResource(
    () => (opened() ? props.endpoint : undefined),
    async (endpoint) =>
      client.api<{
        code: string
        patch: string | null
        quarantined: boolean
        current: boolean
        formalExecutionReason: string
      }>(endpoint),
  )
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>查看候选代码与变更</summary>
      <Show when={candidate.loading}>
        <p>正在核验已保存的候选内容…</p>
      </Show>
      <Show when={candidate.error}>
        <p role="alert">候选内容暂不可核验，请刷新账本后重试。</p>
      </Show>
      <Show when={candidate()}>
        {(value) => (
          <>
            <p>
              {value().quarantined
                ? '隔离的历史结果，不用于实验结论。'
                : value().current
                  ? '候选内容已核验，尚未通过独立代码审阅。'
                  : '依据已变化，此候选需要重新核对。'}
            </p>
            <h6>完整代码</h6>
            <pre style={{ 'max-height': '24rem', overflow: 'auto', 'white-space': 'pre-wrap' }}>
              {value().code}
            </pre>
            <Show when={value().patch}>
              <h6>补丁</h6>
              <pre style={{ 'max-height': '16rem', overflow: 'auto', 'white-space': 'pre-wrap' }}>
                {value().patch}
              </pre>
              <p>补丁仅供检查，不会自动应用。</p>
            </Show>
            <p>{value().formalExecutionReason}</p>
          </>
        )}
      </Show>
    </details>
  )
}
