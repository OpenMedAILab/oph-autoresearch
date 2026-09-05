import type { UsageOverviewResponse, UsageResponse, UsageTotals } from '@oph-autoresearch/core'
import { formatCosts } from '@oph-autoresearch/core'
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { compact } from '../../lib/step-view.ts'
import { client } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

/**
 * 用量页：统计卡 + Token 活动热力图 + 每日趋势图 + 明细账本。
 *
 * 统计卡、热力图与趋势图由 `/api/usage/overview` 一份数据驱动（尺子是「这台机器」
 * 的整个账本），明细账本报 `/api/usage`（尺子是区间与分组，含金额）。两者口径都是
 * `input + output + cached` 的 token 合计，与账本端一致。
 */

const DAY = 86_400_000

/** 趋势图可选的区间（明细账本共用同一份选择）。 */
const RANGES = [7, 30] as const
const GROUPS = [
  { by: 'model', label: '按模型' },
  { by: 'day', label: '按天' },
  { by: 'kind', label: '按类型' },
  { by: 'workspace', label: '按工作区' },
] as const

/**
 * 「此处无可用值」。**与运行页同一个术语**，同一个含义：这个数不存在，而不是它等于 0。
 * 两处各写一个词的话，同一件事在界面上会有两种说法。
 */
const NA = 'N/A'

/** 金额。一笔计价都没有即这个模型没有价目，写成 $0.00 是把「不知道」说成「免费」。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : NA
}

/** 「输入」给含缓存命中的口径：中转站后台账单就是这个数，两边同口径才能对账。 */
function input(t: UsageTotals): number {
  return t.inputTokens + (t.cachedTokens ?? 0)
}

/** 完整数（不缩写）：2,345,678。stat 卡与 tooltip 用。 */
function full(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

/** 中文数量级缩写：1.2万 / 87亿。数字位数是「还能不能一眼比大小」的边界，不是精度。 */
function fmtTokens(n: number): string {
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return full(n)
}

function trim(v: number): string {
  return v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)))
}

/** 时长：X天X小时 / X小时X分钟 / X分钟。整段取到分钟，秒不必报。 */
function fmtDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

/** 本地日 'YYYY-MM-DD'——与账本分组的 strftime(localtime) 同口径。 */
function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function monthLabel(key: string): string {
  const [, m] = key.split('-')
  return `${Number(m)}月`
}

const SERIES_COLORS = ['#8b5cf6', '#6366f1', '#a855f7', '#ec4899', '#06b6d4', '#ef4444', '#84cc16']

/** 六位十六进制 → rgb 分量。渐变定色靠它调亮/调暗。 */
function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 与白/黑按比例混合：> 0 调亮，< 0 调暗。 */
function tint(hex: string, offset: number): string {
  const [r, g, b] = rgbOf(hex)
  const mix = (v: number) => Math.round(offset >= 0 ? v + (255 - v) * offset : v * (1 + offset))
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

export default function UsageSettings() {
  const [trendDays, setTrendDays] = createSignal<(typeof RANGES)[number]>(30)
  const [by, setBy] = createSignal<string>('model')
  const [heatmapMode, setHeatmapMode] = createSignal<'daily' | 'weekly' | 'cumulative'>('daily')
  const [overview, { refetch: refetchOverview }] = createResource(() =>
    client.api<UsageOverviewResponse>('/api/usage/overview'),
  )
  const [ledger, { refetch }] = createResource(
    () => ({ days: trendDays(), by: by() }),
    (q) => client.api<UsageResponse>(`/api/usage?days=${q.days}&by=${q.by}`),
  )

  return (
    <>
      <Show
        when={loaded(overview)}
        fallback={<LoadState error={overview.error} onRetry={() => void refetchOverview()} />}
      >
        {(u) => (
          <>
            <StatCards data={u()} />
            <section class="usage-panel">
              <div class="usage-panel-head">
                <h3>Token 活动</h3>
                <fieldset class="usage-seg">
                  <legend>热力图统计方式</legend>
                  <For
                    each={
                      [
                        { key: 'daily', label: '每日' },
                        { key: 'weekly', label: '每周' },
                        { key: 'cumulative', label: '累计' },
                      ] as const
                    }
                  >
                    {(mode) => (
                      <button
                        classList={{ active: heatmapMode() === mode.key }}
                        type="button"
                        onClick={() => setHeatmapMode(mode.key)}
                      >
                        {mode.label}
                      </button>
                    )}
                  </For>
                </fieldset>
              </div>
              <TokenHeatmap days={u().days} mode={heatmapMode()} />
            </section>
            <section class="usage-panel">
              <div class="usage-panel-head">
                <h3>每日 Token 趋势</h3>
                <fieldset class="usage-seg">
                  <legend>时间范围</legend>
                  <For each={RANGES}>
                    {(d) => (
                      <button
                        classList={{ active: trendDays() === d }}
                        type="button"
                        onClick={() => setTrendDays(d)}
                      >
                        近 {d} 日
                      </button>
                    )}
                  </For>
                </fieldset>
              </div>
              <TokenTrend dailyByModel={u().dailyByModel} days={trendDays()} />
            </section>
          </>
        )}
      </Show>

      {/* 明细账本：区间跟着趋势图的时间范围走，分组自选。 */}
      <Show
        when={loaded(ledger)}
        fallback={<LoadState error={ledger.error} onRetry={() => void refetch()} />}
      >
        {(u) => (
          <section class="usage-ledger-section">
            <div class="usage-bar">
              <div class="usage-ledger-title">明细账本</div>
              <div class="usage-chips">
                <For each={GROUPS}>
                  {(g) => (
                    <button
                      class="usage-chip"
                      classList={{ active: by() === g.by }}
                      type="button"
                      onClick={() => setBy(g.by)}
                    >
                      {g.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="usage-total">
              <span class="usage-total-cost">{money(u().totals.cost)}</span>
              <span class="usage-total-meta">
                {u().totals.entries.toLocaleString('zh-CN')} 笔 · 近 {u().days} 天
              </span>
            </div>
            <Show when={u().rows.length > 0}>
              <div class="usage-scroll">
                <table class="usage-table">
                  <thead>
                    <tr>
                      <th>{GROUPS.find((g) => g.by === u().by)?.label ?? '分组'}</th>
                      <th class="num">笔数</th>
                      <th class="num">输入</th>
                      <th class="num">输出</th>
                      <th class="num">命中</th>
                      <th class="num">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={u().rows}>
                      {(r) => (
                        <tr>
                          <td>{r.key}</td>
                          <td class="num">{r.entries.toLocaleString('zh-CN')}</td>
                          <td class="num">{compact(input(r))}</td>
                          <td class="num">{compact(r.outputTokens)}</td>
                          <td class="num">
                            {r.cachedTokens === null ? NA : compact(r.cachedTokens)}
                          </td>
                          <td class="num">{money(r.cost)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </section>
        )}
      </Show>
    </>
  )
}

/** 顶部五张统计卡：累计、单日峰值、最长单轮、当前/最长连续。 */
function StatCards(props: { data: UsageOverviewResponse }) {
  const d = () => props.data
  const peakValue = createMemo(() => {
    const peak = d().peakDay
    return peak ? fmtTokens(peak.tokens) : NA
  })
  const peakDate = createMemo(() => d().peakDay?.date ?? '暂无记录')
  const runValue = createMemo(() => {
    const ms = d().longestRunMs
    return ms === null ? NA : fmtDuration(ms)
  })
  return (
    <div class="usage-stats">
      <div class="usage-stat">
        <strong>{fmtTokens(d().totalTokens)}</strong>
        <span>累计 Token 数</span>
        <small>共 {d().entries.toLocaleString('zh-CN')} 笔</small>
      </div>
      <div class="usage-stat">
        <strong>{peakValue()}</strong>
        <span>单日峰值</span>
        <small>{peakDate()}</small>
      </div>
      <div class="usage-stat">
        <strong>{runValue()}</strong>
        <span>最长单轮时长</span>
      </div>
      <div class="usage-stat">
        <strong>{d().currentStreak} 天</strong>
        <span>当前连续天数</span>
      </div>
      <div class="usage-stat">
        <strong>{d().longestStreak} 天</strong>
        <span>最长连续天数</span>
      </div>
    </div>
  )
}

interface HeatCell {
  date: Date
  key: string
  tokens: number
}

/** 近一年的活动网格。三种模式共用同一批天数据，取值方式不同。 */
function TokenHeatmap(props: { days: { date: string; tokens: number }[]; mode: string }) {
  const DAYS = createMemo(() => new Map(props.days.map((d) => [d.date, d.tokens])))

  /** 53 周网格：列 = 周（周一开头），行 = 周一..周日。 */
  const grid = createMemo<HeatCell[][]>(() => {
    const now = new Date()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const start = new Date(end.getTime() - (53 * 7 - 1) * DAY)
    const dow = (start.getDay() + 6) % 7 // 0 = 周一
    start.setDate(start.getDate() - dow)
    const out: HeatCell[][] = []
    for (let c = 0; c < 53; c++) {
      const col: HeatCell[] = []
      for (let r = 0; r < 7; r++) {
        const date = new Date(start.getTime() + (c * 7 + r) * DAY)
        const key = localDate(date)
        col.push({ date, key, tokens: DAYS().get(key) ?? 0 })
      }
      out.push(col)
    }
    return out
  })

  /** 每个「字段」的展示值：每日 = 当格，每周 = 本周合计，累计 = 到本周为止的累计。 */
  const cells = createMemo(() => {
    const g = grid()
    if (props.mode === 'daily') return g.flat()
    const weeks = g.map((col) => ({
      date: col[0]!.date,
      tokens: col.reduce((sum, cell) => sum + cell.tokens, 0),
    }))
    let running = 0
    return weeks.map((w) => {
      if (props.mode === 'cumulative') running += w.tokens
      return { ...w, tokens: props.mode === 'cumulative' ? running : w.tokens }
    })
  })

  const max = createMemo(() => Math.max(0, ...cells().map((c) => c.tokens)))

  /** 四个强度档 + 空档。阈值按区间内的最大值取相对量级。 */
  const level = (tokens: number) => {
    if (tokens === 0) return 0
    const m = max()
    const r = m > 0 ? tokens / m : 1
    if (r <= 0.06) return 1
    if (r <= 0.25) return 2
    if (r <= 0.55) return 3
    return 4
  }

  const daily = props.mode === 'daily'
  const monthlyTicks = createMemo(() => {
    const ticks: { col: number; label: string }[] = []
    let prev = ''
    for (const [c, col] of grid().entries()) {
      const key = col[0]!.key.slice(0, 7) // YYYY-MM
      if (key === prev) continue
      prev = key
      ticks.push({ col: c, label: monthLabel(key) })
    }
    return ticks
  })

  return (
    <div class="usage-heatmap">
      <svg
        class="usage-heatmap-grid"
        viewBox={daily ? '0 0 764 118' : '0 0 764 118'}
        role="img"
        aria-label="按日 Token 活动热力图"
      >
        {daily ? (
          <>
            {['一', '三', '五'].map((w, i) => (
              <text class="usage-heat-dow" x={2} y={10 + i * 2 * 14}>
                {w}
              </text>
            ))}
            {grid().map((col, c) =>
              col.map((cell, r) => (
                <rect
                  class={`usage-heat-cell l${level(cell.tokens)}`}
                  x={18 + c * 14}
                  y={2 + r * 14}
                  width={11}
                  height={11}
                  rx={2}
                  data-tip={`${cell.key}：${cell.tokens === 0 ? '无用量' : `${full(cell.tokens)} tokens`}`}
                />
              )),
            )}
            {monthlyTicks().map((t) => (
              <text class="usage-heat-month" x={18 + t.col * 14} y={114}>
                {t.label}
              </text>
            ))}
          </>
        ) : (
          cells().map((cell, i) => (
            <rect
              class={`usage-heat-cell l${level(cell.tokens)}`}
              x={18 + (i % 7) * 14}
              y={2 + Math.floor(i / 7) * 14}
              width={11}
              height={11}
              rx={2}
              data-tip={`${localDate(cell.date)} 起一周：${cell.tokens === 0 ? '无用量' : `${full(cell.tokens)} tokens`}`}
            />
          ))
        )}
      </svg>
    </div>
  )
}

interface TrendModel {
  model: string
  color: string
  values: number[]
}

/** 每日趋势折线图：逐模型线 + 图例 + 悬停读数。 */
function TokenTrend(props: {
  dailyByModel: { date: string; model: string; tokens: number }[]
  days: number
}) {
  const [hover, setHover] = createSignal<number | null>(null)
  const [hoverPos, setHoverPos] = createSignal({ left: 0 })

  const days = createMemo(() => {
    const now = new Date()
    const out: { date: string; label: string }[] = []
    for (let i = props.days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      out.push({
        date: localDate(d),
        label: `${d.getMonth() + 1}月${d.getDate()}日`,
      })
    }
    return out
  })

  /** 模型序列：按区间总量排序取前 6，其余并入「其他」。 */
  const series = createMemo<TrendModel[]>(() => {
    const byModel = new Map<string, number[]>()
    for (const day of props.dailyByModel) {
      const index = days().findIndex((d) => d.date === day.date)
      if (index < 0) continue
      const list = byModel.get(day.model) ?? Array.from({ length: props.days }, () => 0)
      list[index] = (list[index] ?? 0) + day.tokens
      byModel.set(day.model, list)
    }
    const ranked = [...byModel.entries()].sort(
      (a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0),
    )
    const top = ranked.slice(0, 6)
    const rest = ranked.slice(6)
    const out = top.map(([model, values], i) => ({ model, color: SERIES_COLORS[i]!, values }))
    if (rest.length > 0) {
      const merged = Array.from({ length: props.days }, (_, i) =>
        rest.reduce((s, [, values]) => s + (values[i] ?? 0), 0),
      )
      out.push({ model: `其他 ${rest.length} 个`, color: SERIES_COLORS[6]!, values: merged })
    }
    return out
  })

  const totalByDay = createMemo(() => {
    const s = series()
    return Array.from({ length: props.days }, (_, i) =>
      s.reduce((sum, m) => sum + (m.values[i] ?? 0), 0),
    )
  })

  const W = 720
  const H = 236
  const PAD = { left: 52, right: 12, top: 10, bottom: 26 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const maxTokens = createMemo(() => Math.max(1, ...totalByDay()))
  const yMax = createMemo(() => niceMax(maxTokens()))
  const xAt = (i: number) => PAD.left + (props.days === 1 ? 0 : (i / (props.days - 1)) * plotW)
  const yAt = (v: number) => PAD.top + plotH - (v / yMax()) * plotH

  const pathFor = (values: number[]) => smoothPath(values.map((v, i) => ({ x: xAt(i), y: yAt(v) })))

  const t = createMemo(() => {
    const y = yMax()
    const step = y / 4
    const lines: { v: number; label: string }[] = []
    for (let i = 0; i <= 4; i++) lines.push({ v: step * i, label: fmtTick(step * i) })
    return lines
  })

  const xLabels = createMemo(() => {
    const d = days()
    const step = props.days <= 7 ? 1 : 5
    return d.map((day, i) => ({ i, ...day })).filter(({ i }) => i % step === 0)
  })

  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const i = Math.round(ratio * (props.days - 1))
    setHover(i)
    setHoverPos({ left: (xAt(i) / W) * 100 })
  }

  const hasData = createMemo(() => series().length > 0 && totalByDay().some((v) => v > 0))

  return (
    <div class="usage-trend">
      <Show when={hasData()} fallback={<div class="usage-empty">这段时间没有用量记录</div>}>
        <div class="usage-trend-legend">
          <For each={series()}>
            {(m) => (
              <span class="usage-legend-item">
                <i style={{ background: m.color }} />
                {m.model}
              </span>
            )}
          </For>
        </div>
        <div class="usage-trend-canvas" style={{ position: 'relative' }}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每日 Token 趋势图">
            {t().map((line) => (
              <g>
                <line
                  class="usage-trend-gridline"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={yAt(line.v)}
                  y2={yAt(line.v)}
                />
                <text
                  class="usage-trend-ylabel"
                  x={PAD.left - 8}
                  y={yAt(line.v) + 3}
                  text-anchor="end"
                >
                  {line.label}
                </text>
              </g>
            ))}
            {xLabels().map((day) => (
              <text class="usage-trend-xlabel" x={xAt(day.i)} y={H - 8} text-anchor="middle">
                {day.label}
              </text>
            ))}
            <For each={series()}>
              {(m, i) => (
                <g>
                  <defs>
                    {/* 描边横向渐变：同色系由深到亮，配上面的紫色系调色板，
                        曲线就带出参考图那种渐变质感。 */}
                    <linearGradient id={`usage-line-g${i()}`} x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stop-color={tint(m.color, -0.25)} />
                      <stop offset="0.55" stop-color={m.color} />
                      <stop offset="1" stop-color={tint(m.color, 0.35)} />
                    </linearGradient>
                    {/* 面积纵向渐变：色 → 透明，比平铺 7% 更像「淡开」的阴影。 */}
                    <linearGradient id={`usage-area-g${i()}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stop-color={m.color} stop-opacity="0.28" />
                      <stop offset="1" stop-color={m.color} stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    class="usage-trend-area"
                    d={`${pathFor(m.values)} L ${xAt(props.days - 1)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`}
                    fill={`url(#usage-area-g${i()})`}
                  />
                  <path
                    class="usage-trend-line"
                    d={pathFor(m.values)}
                    stroke={`url(#usage-line-g${i()})`}
                    fill="none"
                  />
                </g>
              )}
            </For>
            <Show when={hover() !== null}>
              <g>
                <line
                  class="usage-trend-guide"
                  x1={xAt(hover() ?? 0)}
                  x2={xAt(hover() ?? 0)}
                  y1={PAD.top}
                  y2={H - PAD.bottom}
                />
                {series().map((m) => (
                  <circle
                    class="usage-trend-dot"
                    cx={xAt(hover() ?? 0)}
                    cy={yAt(m.values[hover() ?? 0] ?? 0)}
                    r={3}
                    fill={m.color}
                  />
                ))}
              </g>
            </Show>
            {/* 透明描边层接指针；preserveAspectRatio=none 下坐标用比例换算。 */}
            <rect
              class="usage-trend-hit"
              x={0}
              y={0}
              width={W}
              height={H}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
          <Show when={hover() !== null && hasData()}>
            <div class="usage-trend-tip" style={{ left: `${hoverPos().left}%` }}>
              <strong>{days()[hover() ?? 0]?.label}</strong>
              <span>合计 {full(totalByDay()[hover() ?? 0] ?? 0)}</span>
              <For each={series().slice(0, 3)}>
                {(m) => (
                  <span class="usage-trend-tip-row">
                    <i style={{ background: m.color }} />
                    {m.model} · {fmtTokens(m.values[hover() ?? 0] ?? 0)}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** 纵轴刻度：整数化 + 万/亿。 */
function fmtTick(v: number): string {
  if (v >= 1e8) return `${trim(v / 1e8)}亿`
  if (v >= 1e4) return `${trim(v / 1e4)}万`
  return String(Math.round(v))
}

/** 0..v 的「好看」上限：给个整的量级，刻度线才不落在一串小数上。 */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) {
    const candidate = m * mag
    if (v <= candidate) return candidate
  }
  return 10 * mag
}

/** Catmull-Rom → 三次贝塞尔：折线在「天」这种均匀横轴上看着更平滑。 */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(points.length - 1, i + 2)]!
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}
