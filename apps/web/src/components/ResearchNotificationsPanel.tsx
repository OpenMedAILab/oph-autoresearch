import { createEffect, createResource, createSignal, For, onCleanup, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

const kinds = {
  approval_needed: '等待研究审批',
  failure: '实验未完成',
  unknown: '运行状态待核对',
  cancel_pending: '正在确认取消',
  completed: '实验结果已核验',
  review_insufficient: '独立复核发现证据不足',
  review_failed: '独立复核执行失败',
}
type Receipt = {
  kind: keyof typeof kinds
  channel: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  createdAt: number
}
export function ResearchNotificationsPanel(props: {
  campaignId: string
  workspaceId: string
  version: number
}) {
  const [opened, setOpened] = createSignal(false)
  const [receipts, { refetch }] = createResource(
    () => `${props.campaignId}:${props.version}`,
    async () =>
      client.api<{ notifications: Receipt[] }>(
        `/api/research/campaigns/${props.campaignId}/notifications?ws=${encodeURIComponent(props.workspaceId)}`,
      ),
  )
  createEffect(() => {
    if (!opened()) return
    void refetch()
    const timer = setInterval(() => {
      if (!receipts.loading) void refetch()
    }, 10000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>通知投递记录</summary>
      <button type="button" disabled={receipts.loading} onClick={() => void refetch()}>
        刷新投递状态
      </button>
      <p>仅向已启用的通知渠道投递。未确认的投递会重试，接收端可能重复收到。</p>
      <Show when={receipts.error}>
        <p role="alert">投递记录暂时无法读取。</p>
      </Show>
      <Show when={receipts()?.notifications.length === 0}>
        <p>暂无投递记录。</p>
      </Show>
      <For each={receipts()?.notifications}>
        {(item) => (
          <p>
            {kinds[item.kind]} ·{' '}
            {{ pending: '等待投递', delivered: '已确认送达', failed: '投递失败' }[item.status]} ·
            尝试 {item.attempts} 次 · {new Date(item.createdAt).toLocaleString()}
          </p>
        )}
      </For>
    </details>
  )
}
