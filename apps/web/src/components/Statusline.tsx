/**
 * 输入框下方的常驻状态栏——「这条会话花了多少」的合计家。
 *
 * **为什么在这里，不在右侧面板。** 右侧面板的「运行」页只做对话流做不到的两件事：
 * 跨轮合计与逐轮下钻。下钻（逐请求表）已随该页删掉；合计这一半交给常驻状态栏——
 * 用户不必翻页，扫一眼即知。逐轮的读数仍在会话流每轮末尾的 `.run-strip`，
 * 两者口径互补、互不重复：那里的「本轮」数的是这一轮，这里的「本会话」数的是全部轮次。
 *
 * **没有记录就说不存在，不说零。** 「一笔都没跑」显示占位文案，不摆一排 0——
 * 把「还没开始」说成「花了零元」是假话（沿用原运行页的规矩）。
 * 金额同理：这个模型没有计价时显示 N/A，而不是 $0.00。
 *
 * **合计取账本，不取 runs 相加。** 账本（`usage_ledger`）收着轮次之间那几笔
 * （压缩摘要等），把 run 加起来必然少算——那不是口径选择，是漏账。
 * 正在跑的那一轮单独并进来：账本在收尾时才记，不并的话运行中合计会少一笔。
 */
import type {
  ConversationUsageResponse,
  Currency,
  Run,
  UsageLedgerRow,
  UsageTotals,
} from '@oph-autoresearch/core'
import { formatCosts } from '@oph-autoresearch/core'
import { createMemo, createResource, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { compact } from '../lib/step-view.ts'
import { client, isRunning, ledgerRevision, state } from '../lib/store/index.ts'
import { IconSpinner } from './Icons.tsx'

export default function Statusline() {
  /*
   * 判据按值去重，不能是每次都新建的那个对象字面量（同原运行页的写法）：
   * `createResource` 把 source 包进 memo 按 `===` 比，对象字面量每次都不相等——
   * 别的会话开跑一次、某一轮的金额原地改一次，这两张表就各重取一遍。
   */
  const key = createMemo(
    () => ({ id: state.activeConversation, rev: ledgerRevision() }),
    undefined,
    { equals: (a, b) => a.id === b.id && a.rev === b.rev },
  )

  const [runsData] = createResource(key, async (k) =>
    k.id === null
      ? { runs: [] as Run[] }
      : await client.api<{ runs: Run[] }>(`/api/conversations/${k.id}/runs`),
  )
  const [ledgerData] = createResource(key, async (k) =>
    k.id === null
      ? { totals: emptyTotals(), entries: [] as UsageLedgerRow[] }
      : await client.api<ConversationUsageResponse>(`/api/conversations/${k.id}/usage`),
  )

  const runs = () => loaded(runsData)?.runs ?? []
  const running = () => runs().filter((r) => r.finishedAt === null)

  /** 账本合计 + 正在跑的那一轮（它还没进账本，不并就少一笔）。 */
  const totals = createMemo(() => {
    const base = loaded(ledgerData)?.totals ?? emptyTotals()
    return running().reduce(
      (acc, r) => ({
        input: acc.input + (r.usage?.inputTokens ?? 0),
        output: acc.output + (r.usage?.outputTokens ?? 0),
        cached: addMaybe(acc.cached, r.usage?.cachedTokens),
        cacheWrite: addMaybe(acc.cacheWrite, r.usage?.cacheWriteTokens),
        cost: addCost(acc.cost, r.usage?.cost, r.usage?.currency),
      }),
      {
        input: base.inputTokens,
        output: base.outputTokens,
        cached: base.cachedTokens,
        cacheWrite: base.cacheWriteTokens,
        cost: { ...base.cost },
      },
    )
  })

  /** 第一次拉到账本之前 `totals()` 是空桶，此时不显示合计（也不显示 0）。 */
  const blank = () => loaded(ledgerData) === undefined && loaded(runsData) === undefined
  const empty = () => runs().length === 0 && totals().input === 0

  return (
    <div class="statusline">
      <Show when={!blank() && empty()} fallback={<span class="statusline-scope">本会话</span>}>
        <span class="statusline-empty">本会话 · 暂无运行</span>
      </Show>
      <Show when={!blank() && !empty()}>
        <span class="statusline-scope">本会话</span>
        <span class="statusline-metric" data-tip="输入 / 输出 token">
          {runs().some((run) => run.usage?.reporting === 'unavailable')
            ? '包含未回报 CLI 用量'
            : `↓${compact(totals().input + (totals().cached ?? 0))} ↑${compact(totals().output)}`}
        </span>
        <span class="statusline-metric statusline-cost">
          {money(totals().cost)}
          {runs().some((run) => run.usage?.reporting === 'unavailable') ? ' + CLI 费用未知' : ''}
        </span>
        <span class="statusline-metric">{runs().length} 轮</span>
      </Show>
      {/* 运行状态放在最右：它是这一条里唯一「正在变」的，与按需刷新的合计隔开。 */}
      <span class="statusline-state" data-status={isRunning() ? 'running' : 'idle'}>
        <Show when={isRunning()}>
          <IconSpinner size={11} />
        </Show>
        {isRunning() ? '运行中' : '空闲'}
      </span>
    </div>
  )
}

/** 金额合计。一笔计价都没有时不是零元，是没有价目。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : NA
}

/** 累加一个「可能没给」的计数。两边都没给过时保持 `null`。 */
function addMaybe(acc: number | null, v: number | null | undefined): number | null {
  return v === null || v === undefined ? acc : (acc ?? 0) + v
}

/** 把一笔花费并进按币种分的桶里。**不跨币种相加。** */
function addCost(
  acc: Record<string, number>,
  cost: number | null | undefined,
  currency: Currency | undefined,
): Record<string, number> {
  if (!cost) return acc
  const cur = currency ?? 'USD'
  return { ...acc, [cur]: (acc[cur] ?? 0) + cost }
}

/** 没有活动会话时的空账。给一份而不是不取，界面才有恒定的形状。 */
function emptyTotals(): UsageTotals {
  return {
    entries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    cost: {},
  }
}

/**
 * 没有这个数时写它。
 *
 * **是术语，不是符号**：一根横线读者认不出它在说什么——是零、是省略、还是没取到。
 * `N/A` 是数据表里「此处无可用值」的通用写法，含义唯一，也不会被当成数字。
 */
const NA = 'N/A'
