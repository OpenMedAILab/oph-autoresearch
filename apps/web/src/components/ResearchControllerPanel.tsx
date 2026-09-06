import type { ResearchCampaign, ResearchControllerLimits } from '@oph-autoresearch/core'
import { createSignal, For, Show } from 'solid-js'
import { requestHumanApproval } from '../lib/research-approval.ts'
import { client } from '../lib/store/index.ts'

export function ResearchControllerPanel(props: {
  campaign: ResearchCampaign
  approvalUrl: string | null
  busy: boolean
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const [requests, setRequests] = createSignal(6)
  const [advances, setAdvances] = createSignal(3)
  const [minutes, setMinutes] = createSignal(10)
  const [stopAfter, setStopAfter] = createSignal<'candidate' | 'review'>('candidate')
  const current = () =>
    props.campaign.controllerReservations?.find(
      (item) => item.id === props.campaign.progressControl?.reservationRef,
    )
  const reusableApproval = () =>
    props.campaign.approvals.find(
      (item) =>
        item.status === 'active' &&
        !item.consumedBy &&
        item.bundleHash === props.campaign.bundleHash &&
        item.scope?.kind === 'controller' &&
        item.scope.expiresAt > Date.now(),
    )
  function start() {
    const campaign = props.campaign
    const endpoint = `/api/research/campaigns/${campaign.id}`
    const suffix = `?ws=${encodeURIComponent(campaign.workspaceId)}`
    const approvalUrl = props.approvalUrl
    const reusable = reusableApproval()
    const popup = reusable ? null : window.open('about:blank', 'oph-research-approval')
    const limits: ResearchControllerLimits = reusable?.scope?.controllerLimits ?? {
      maxAdvances: advances(),
      maxModelRequests: requests(),
      maxOutputTokens: 1024,
      maxInputCharacters: 4096,
      deadlineAt: Date.now() + minutes() * 60_000,
      stopAfter: stopAfter(),
    }
    return props.act(async () => {
      try {
        let approved = { campaign }
        if (!reusable) {
          if (!popup || !approvalUrl) throw new Error('请配置审批渠道并允许独立审批窗口')
          const quote = await client.api<{
            body: { expectedVersion: number; scope: { controllerLimits: ResearchControllerLimits } }
          }>(`${endpoint}/controller/quote${suffix}`, {
            method: 'POST',
            body: JSON.stringify({ limits }),
          })
          const proof = await requestHumanApproval(
            approvalUrl,
            {
              workspaceId: campaign.workspaceId,
              campaignId: campaign.id,
              action: 'approve',
              body: quote.body,
            },
            popup,
          )
          approved = await client.api<{ campaign: ResearchCampaign }>(
            `${endpoint}/approve${suffix}`,
            {
              method: 'POST',
              headers: { 'x-oph-human-proof': proof },
              body: JSON.stringify(quote.body),
            },
          )
        }
        const approval = approved.campaign.approvals.find(
          (item) =>
            item.status === 'active' &&
            !item.consumedBy &&
            item.scope?.kind === 'controller' &&
            JSON.stringify(item.scope.controllerLimits) === JSON.stringify(limits),
        )
        if (!approval) throw new Error('主控推进审批尚未生效')
        const reservationId = `rcr_${approval.id}`
        await client.api(`${endpoint}/controller/start${suffix}`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: approved.campaign.version,
            expectedGeneration: approved.campaign.progressControl?.generation ?? 0,
            idempotencyKey: `controller-start:${reservationId}`,
            reservationId,
            approvalId: approval.id,
            limits,
          }),
        })
      } finally {
        popup?.close()
      }
    }, '主控推进已批准。模型请求和推进操作均按持久限额计数，实验执行仍需单独批准。')
  }
  return (
    <details>
      <summary>有界主控推进</summary>
      <p>
        限定主控的模型请求、推进操作和截止时间。主控只使用研究工具；远端运行、代码审阅和正式实验各自保留审批边界。遇到等待或不确定状态时停止本轮。
      </p>
      <Show when={current()}>
        {(item) => (
          <p>
            当前推进：
            {
              {
                active: '可继续',
                held: '已暂停',
                exhausted: '本次限额已结束',
                completed: '本次推进已结束',
              }[item().status]
            }{' '}
            {item().waiting
              ? ` · ${{ remote: '等待远端完成，届时自动继续', human: '等待独立人类审批', change: '等待研究依据更新', unknown: '状态待核对，不会重新投递' }[item().waiting!]}`
              : ''}
            · 模型请求 {item().requests.length}/{item().limits.maxModelRequests} · 推进操作{' '}
            {item().advancesUsed}/{item().limits.maxAdvances} ·{' '}
            {item().actualCost === null
              ? '实际费用待核对'
              : `已知费用 ${item().actualCost} ${item().currency}`}
          </p>
        )}
      </Show>
      <For each={props.campaign.controllerReservations ?? []}>
        {(item, index) => (
          <p>
            第 {index() + 1} 次主控推进 · 预留 {item.reservedCost} {item.currency} · 截止{' '}
            {new Date(item.limits.deadlineAt).toLocaleString()}
          </p>
        )}
      </For>
      <label>
        模型请求上限
        <input
          type="number"
          min="1"
          max="50"
          value={requests()}
          onInput={(event) => setRequests(Number(event.currentTarget.value))}
        />
      </label>
      <label>
        推进操作上限
        <input
          type="number"
          min="1"
          max="50"
          value={advances()}
          onInput={(event) => setAdvances(Number(event.currentTarget.value))}
        />
      </label>
      <label>
        最长持续分钟
        <input
          type="number"
          min="1"
          max="1440"
          value={minutes()}
          onInput={(event) => setMinutes(Number(event.currentTarget.value))}
        />
      </label>
      <label>
        停止阶段
        <select
          value={stopAfter()}
          onChange={(event) => setStopAfter(event.currentTarget.value as 'candidate' | 'review')}
        >
          <option value="candidate">获得候选代码</option>
          <option value="review">完成独立复核</option>
        </select>
      </label>
      <p>
        每次模型调用最多输出 1024 tokens，输入最多 4096
        字符；压缩上下文也消耗请求次数。按已配置价格预留，服务商费用缺失时不当作零。
      </p>
      <button
        type="button"
        disabled={
          props.busy ||
          !props.approvalUrl ||
          [requests(), advances(), minutes()].some(
            (value) => !Number.isSafeInteger(value) || value < 1,
          )
        }
        onClick={() => void start()}
      >
        {reusableApproval() ? '继续已批准的主控推进' : '独立批准并开始有界推进'}
      </button>
    </details>
  )
}
