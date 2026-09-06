import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createResource, For, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

interface Projection {
  nodes: Array<{
    readableTitle: string
    state: string
    freshness: string
    explanation: string
    nextActions: Array<{ readableTitle: string }>
  }>
}
const states: Record<string, string> = {
  blocked: '等待条件',
  ready: '可继续',
  waiting_human: '等待人工确认',
  in_flight: '进行中',
  satisfied: '依据已具备',
}
export function ResearchFlowPanel(props: {
  campaign: ResearchCampaign
  busy: boolean
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const endpoint = () => `/api/research/campaigns/${props.campaign.id}`
  const suffix = () => `?ws=${encodeURIComponent(props.campaign.workspaceId)}`
  const [projection] = createResource(
    () => `${props.campaign.id}:${props.campaign.version}`,
    async () => {
      const result = await client.api<{ projection: Projection }>(
        `${endpoint()}/next_actions${suffix()}`,
      )
      if (!Array.isArray(result.projection?.nodes)) throw new Error('流程状态暂不可用')
      return result.projection
    },
  )
  const held = () => props.campaign.progressControl?.state === 'held'
  const toggle = () =>
    props.act(
      async () => {
        await client.api(`${endpoint()}/progress${suffix()}`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: props.campaign.version,
            expectedGeneration: props.campaign.progressControl?.generation ?? 0,
            idempotencyKey: crypto.randomUUID(),
            state: held() ? 'active' : 'held',
          }),
        })
      },
      held()
        ? '已恢复手动推进；不会自动启动模型或实验。'
        : '已暂停新增推进。已批准的远端工作继续运行，可在运行卡片单独取消。',
    )
  return (
    <section aria-label="研究进度与下一步">
      <h5>研究进度与下一步</h5>
      <p>{held() ? '本会话主控已暂停' : '手动推进'} · 每次操作仍需满足当前审批与依赖条件。</p>
      <button type="button" disabled={props.busy} onClick={() => void toggle()}>
        {held() ? '恢复手动推进' : '暂停本会话主控'}
      </button>
      <p>
        本会话的研究项目共用主控；暂停会停止整个会话的本机主控，并阻止此研究新增执行。已批准的远端运行、状态核对和清理继续。取消远端运行请使用对应运行卡片。
      </p>
      <Show when={projection.error}>
        <p>流程状态暂不可读取，请刷新账本后重试。</p>
      </Show>
      <Show when={!projection.error && projection()}>
        {(value) => (
          <ol>
            <For each={value().nodes}>
              {(node) => (
                <li>
                  <strong>{node.readableTitle}</strong> · {states[node.state] ?? '待核对'}
                  {node.freshness === 'stale' ? ' · 依据需更新' : ''}
                  <p>{node.explanation}</p>
                  <For each={node.nextActions}>
                    {(action) => <p>下一步：{action.readableTitle}。请在下方对应区域操作。</p>}
                  </For>
                </li>
              )}
            </For>
          </ol>
        )}
      </Show>
      <p>这里显示当前账本的核对结果。尚未准入的流程步骤不会自动执行。</p>
    </section>
  )
}
