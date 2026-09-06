import type {
  ResearchCampaign,
  ResearchCostEvidence,
  ResearchCostSubject,
} from '@oph-autoresearch/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { requestHumanApproval } from '../lib/research-approval.ts'
import { client } from '../lib/store/index.ts'

interface CostState {
  summary: {
    currency: string
    limit: number
    committedCost: number
    settledCost: number
    availableCost: number
    overLimit: boolean
    subjects: Array<{
      subject: ResearchCostSubject
      reservation: number
      knownActualCost: number | null
      settled: boolean
      settledAmount: number | null
    }>
  }
  evidence: ResearchCostEvidence[]
}
export function ResearchCostPanel(props: {
  campaign: ResearchCampaign
  approvalUrl: string | null
  busy: boolean
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const endpoint = () => `/api/research/campaigns/${props.campaign.id}`
  const suffix = () => `?ws=${encodeURIComponent(props.campaign.workspaceId)}`
  const [value] = createResource(
    () => `${props.campaign.id}:${props.campaign.version}`,
    async () => {
      const result = await client.api<CostState>(`${endpoint()}/costs${suffix()}`)
      if (!Array.isArray(result.summary?.subjects) || !Array.isArray(result.evidence))
        throw new Error('费用记录暂不可用')
      return result
    },
  )
  const current = () => (value.error ? undefined : value())
  const [subject, setSubject] = createSignal('')
  const [amount, setAmount] = createSignal('')
  const [description, setDescription] = createSignal('')
  let evidenceKey = crypto.randomUUID()
  const label = (item: ResearchCostSubject) => {
    const index =
      item.kind === 'cli_preparation'
        ? (props.campaign.cliPreparations ?? []).findIndex((candidate) => candidate.id === item.id)
        : item.kind === 'controller'
          ? (props.campaign.controllerReservations ?? []).findIndex(
              (candidate) => candidate.id === item.id,
            )
          : item.kind === 'formal_review'
            ? (props.campaign.formalReviewDispatches ?? []).findIndex(
                (candidate) => candidate.id === item.id,
              )
            : (props.campaign.modelReviews ?? []).findIndex((candidate) => candidate.id === item.id)
    return `第 ${index + 1} 次${item.kind === 'cli_preparation' ? '代码准备' : item.kind === 'controller' ? '主控推进' : item.kind === 'formal_review' ? '候选代码审阅' : '独立复核'}`
  }
  const record = () =>
    props.act(async () => {
      const selected = current()?.summary.subjects.find(
        (item) => `${item.subject.kind}:${item.subject.id}` === subject(),
      )
      if (!selected || selected.settled) throw new Error('请选择尚未结算的费用记录')
      await client.api(`${endpoint()}/costs/evidence${suffix()}`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: props.campaign.version,
          idempotencyKey: evidenceKey,
          subject: selected.subject,
          amount: Number(amount()),
          description: description().trim(),
        }),
      })
      evidenceKey = crypto.randomUUID()
    }, '费用依据已记录；预留仍保留，需独立人工签署后才能结算。')
  async function settle(evidence: ResearchCostEvidence) {
    const reusable = props.campaign.approvals.find(
      (item) =>
        item.status === 'active' &&
        !item.consumedBy &&
        item.bundleHash === props.campaign.bundleHash &&
        item.scope?.kind === 'cost_settlement' &&
        item.scope.costEvidenceId === evidence.id &&
        item.scope.expiresAt > Date.now(),
    )
    const popup = reusable ? null : window.open('about:blank', 'oph-research-approval')
    const captured = {
      endpoint: endpoint(),
      suffix: suffix(),
      campaignId: props.campaign.id,
      workspaceId: props.campaign.workspaceId,
      approvalUrl: props.approvalUrl,
      campaign: props.campaign,
    }
    await props.act(async () => {
      try {
        let signed = { campaign: captured.campaign }
        if (!reusable) {
          if (!popup || !captured.approvalUrl)
            throw new Error('请配置审批渠道并允许打开独立审批窗口。')
          const quote = await client.api<{
            body: { expectedVersion: number; scope: { costEvidenceId: string } }
          }>(
            `${captured.endpoint}/costs/quote${captured.suffix}&evidenceId=${encodeURIComponent(evidence.id)}`,
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
          signed = await client.api<{ campaign: ResearchCampaign }>(
            `${captured.endpoint}/approve${captured.suffix}`,
            {
              method: 'POST',
              headers: { 'x-oph-human-proof': proof },
              body: JSON.stringify(quote.body),
            },
          )
        }
        const approval = signed.campaign.approvals.find(
          (item) =>
            item.status === 'active' &&
            !item.consumedBy &&
            item.scope?.kind === 'cost_settlement' &&
            item.scope.costEvidenceId === evidence.id,
        )
        if (!approval) throw new Error('费用结算审批未生效')
        await client.api(`${captured.endpoint}/costs/settle${captured.suffix}`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: signed.campaign.version,
            idempotencyKey: `settle:${evidence.id}`,
            evidenceId: evidence.id,
            approvalId: approval.id,
          }),
        })
      } finally {
        popup?.close()
      }
    }, '已按独立批准的费用依据结算；这不会授权新的实验或模型调用。')
  }
  return (
    <details>
      <summary>研究费用与结算</summary>
      <Show when={value.error}>
        <p>费用记录暂不可读取，已有研究操作仍可继续。</p>
      </Show>
      <Show when={current()}>
        {(state) => (
          <>
            <p>
              预算 {state().summary.limit} {state().summary.currency} · 已结算{' '}
              {state().summary.settledCost} · 占用 {state().summary.committedCost} · 可用{' '}
              {state().summary.availableCost}
            </p>
            <Show when={state().summary.overLimit}>
              <p role="alert">已知费用超过当前预算，新支出已阻止。请核对费用或调整预算。</p>
            </Show>
            <For each={state().summary.subjects}>
              {(item) => (
                <p>
                  {label(item.subject)} ·{' '}
                  {item.settled
                    ? `已结算 ${item.settledAmount}${item.knownActualCost !== null && item.knownActualCost > (item.settledAmount ?? 0) ? `；另有已知费用 ${item.knownActualCost}，待核对差额 ${item.knownActualCost - (item.settledAmount ?? 0)}` : ''}`
                    : `预留 ${item.reservation}；${item.knownActualCost === null ? '实际费用未知' : `已知费用 ${item.knownActualCost}`}`}{' '}
                  {state().summary.currency}
                </p>
              )}
            </For>
            <p>
              未知费用不会按零计算。取消或失败后仍保留预留；请以账单或明确的核账依据进行人工结算。
            </p>
            <label>
              结算对象
              <select
                value={subject()}
                onChange={(event) => {
                  setSubject(event.currentTarget.value)
                  evidenceKey = crypto.randomUUID()
                }}
              >
                <option value="">选择未结算记录</option>
                <For each={state().summary.subjects.filter((item) => !item.settled)}>
                  {(item) => (
                    <option value={`${item.subject.kind}:${item.subject.id}`}>
                      {label(item.subject)}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label>
              核对后的费用金额
              <input
                type="number"
                min="0"
                step="any"
                value={amount()}
                onInput={(event) => {
                  setAmount(event.currentTarget.value)
                  evidenceKey = crypto.randomUUID()
                }}
              />
            </label>
            <label>
              结算依据
              <textarea
                maxLength={2000}
                rows={3}
                placeholder="说明账单来源或人工核账依据"
                value={description()}
                onInput={(event) => {
                  setDescription(event.currentTarget.value)
                  evidenceKey = crypto.randomUUID()
                }}
              />
            </label>
            <button
              type="button"
              disabled={
                props.busy ||
                !subject() ||
                amount().trim() === '' ||
                !Number.isFinite(Number(amount())) ||
                Number(amount()) < 0 ||
                !description().trim()
              }
              onClick={() => void record()}
            >
              记录费用依据
            </button>
            <For
              each={state().evidence.filter(
                (item) =>
                  !props.campaign.costSettlements?.some(
                    (settlement) =>
                      settlement.subject.kind === item.subject.kind &&
                      settlement.subject.id === item.subject.id,
                  ),
              )}
            >
              {(evidence) => (
                <section>
                  <h6>{label(evidence.subject)}的结算依据</h6>
                  <p>
                    {evidence.amount} {evidence.currency} · {evidence.description}
                  </p>
                  <button
                    type="button"
                    disabled={props.busy || !props.approvalUrl}
                    onClick={() => void settle(evidence)}
                  >
                    独立签署并结算
                  </button>
                </section>
              )}
            </For>
          </>
        )}
      </Show>
    </details>
  )
}
