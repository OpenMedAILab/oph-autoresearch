import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import {
  createConversation,
  createRun,
  openProviderRequest,
  settleProviderRequest,
  upsertWorkspace,
} from './repos.ts'
import {
  pruneUsage,
  recordUsage,
  summaryOutputPercentile,
  type UsageEntry,
  usageBy,
  usageDaily,
  usageDailyByModel,
  usageEntries,
  usageLongestRunMs,
  usageStreaks,
  usageTotals,
} from './usage.ts'

const DAY = 86_400_000

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    kind: 'run',
    model: 'deepseek-v4-flash',
    provider: 'openai_chat_completions',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    reasoningTokens: 0,
    cost: 0.001,
    ...over,
  }
}

function fresh(): Store {
  return new Store({ path: ':memory:' })
}

describe('记账', () => {
  test('记一笔能查回总数', () => {
    const s = fresh()
    recordUsage(s, entry())
    const t = usageTotals(s)
    expect(t.entries).toBe(1)
    expect(t.inputTokens).toBe(100)
    expect(t.cost.USD).toBeCloseTo(0.001, 6)
    s.close()
  })

  test('空账本返回 0 而不是抛', () => {
    const s = fresh()
    expect(usageTotals(s).entries).toBe(0)
    // 空账本是 `{}` 不是 `{USD: 0}`：「这段区间没花钱」不该凭空冒出一个币种。
    expect(usageTotals(s).cost).toEqual({})
    s.close()
  })

  /**
   * 同一个 run 只能有一笔。收尾逻辑万一被走两遍（重连补发、异常路径），
   * 唯一索引挡住它——账目静默翻倍是最难发现的那种错。
   */
  test('同一个 run 记两次，第二次被拒且不改账', () => {
    const s = fresh()
    expect(recordUsage(s, entry({ runId: 'rn_1' }))).toBe(true)
    expect(recordUsage(s, entry({ runId: 'rn_1' }))).toBe(false)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })

  test('没有 runId 的（摘要调用）可以记很多笔', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'summary', runId: null }))
    recordUsage(s, entry({ kind: 'summary', runId: null }))
    expect(usageTotals(s).entries).toBe(2)
    s.close()
  })

  /**
   * 账目要比业务数据活得久：删会话是正常操作，而「这个月花了多少」不该少一笔。
   * 所以这张表没有外键——这条测试就是在钉这个设计。
   */
  test('引用一个不存在的会话也能记 —— 账本不设外键', () => {
    const s = fresh()
    expect(recordUsage(s, entry({ conversationId: 'cv_从来没有过' }))).toBe(true)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })
})

describe('缓存命中：未回报与真实 0 不能混', () => {
  test('一笔都没回报过 → null', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: null }))
    expect(usageTotals(s).cachedTokens).toBeNull()
    s.close()
  })

  test('回报过 0 → 0，不是 null', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: 0 }))
    expect(usageTotals(s).cachedTokens).toBe(0)
    s.close()
  })

  test('部分回报 → 只累加回报过的那些', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: null }))
    recordUsage(s, entry({ cachedTokens: 7 }))
    expect(usageTotals(s).cachedTokens).toBe(7)
    s.close()
  })
})

describe('区间与筛选', () => {
  test('since / until 是左闭右开', () => {
    const s = fresh()
    recordUsage(s, entry({ occurredAt: 1000 }))
    recordUsage(s, entry({ occurredAt: 2000 }))
    recordUsage(s, entry({ occurredAt: 3000 }))
    expect(usageTotals(s, { since: 2000, until: 3000 }).entries).toBe(1)
    s.close()
  })

  test('按工作区筛', () => {
    const s = fresh()
    recordUsage(s, entry({ workspaceId: 'ws_a' }))
    recordUsage(s, entry({ workspaceId: 'ws_b' }))
    expect(usageTotals(s, { workspaceId: 'ws_a' }).entries).toBe(1)
    s.close()
  })

  test('按 kind 筛 —— 能单独问「压缩花了多少」', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'run', runId: 'rn_1' }))
    recordUsage(s, entry({ kind: 'summary', cost: 0.005 }))
    expect(usageTotals(s, { kind: 'summary' }).cost.USD).toBeCloseTo(0.005, 6)
    s.close()
  })
})

describe('分组', () => {
  /**
   * 按**笔数**倒序，不按金额：多币种下「金额倒序」没有唯一解
   * （¥100 和 $20 谁在前？要汇率才知道），而笔数无量纲、跨币种可比。
   */
  test('按模型分组，用得多的在前', () => {
    const s = fresh()
    recordUsage(s, entry({ model: '少用的', cost: 0.5 }))
    recordUsage(s, entry({ model: '常用的', runId: 'rn_a', cost: 0.001 }))
    recordUsage(s, entry({ model: '常用的', runId: 'rn_b', cost: 0.001 }))
    const rows = usageBy(s, 'model')
    expect(rows[0]!.key).toBe('常用的')
    expect(rows).toHaveLength(2)
    s.close()
  })

  /**
   * **两种币种分开列，不相加。** 合起来要一个汇率，而汇率天天变——
   * 落盘之后那个数字就不再成立，而它看起来仍然是个确切的金额。
   */
  test('多币种分开合计', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'claude', cost: 0.5 }))
    recordUsage(s, entry({ model: 'glm', runId: 'rn_c', cost: 3, currency: 'CNY' }))
    const t = usageTotals(s)
    expect(t.cost.USD).toBeCloseTo(0.5, 6)
    expect(t.cost.CNY).toBeCloseTo(3, 6)
    expect(t.entries).toBe(2)
    s.close()
  })

  /** 同一个分组里也可能两种币种共存——`--by day` 就是典型。 */
  test('同一分组里的两种币种各归各的', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'm', cost: 0.5, occurredAt: 1000 }))
    recordUsage(s, entry({ model: 'm', runId: 'rn_d', cost: 3, currency: 'CNY', occurredAt: 1000 }))
    const row = usageBy(s, 'day')[0]!
    expect(row.cost.USD).toBeCloseTo(0.5, 6)
    expect(row.cost.CNY).toBeCloseTo(3, 6)
    s.close()
  })

  /** 币种本身可以当分组维度：「人民币那边一共花了多少」是个会被问的问题。 */
  test('能按币种分组', () => {
    const s = fresh()
    recordUsage(s, entry({ cost: 0.5 }))
    recordUsage(s, entry({ runId: 'rn_e', cost: 3, currency: 'CNY' }))
    const rows = usageBy(s, 'currency')
    expect(rows.map((r) => r.key).sort()).toEqual(['CNY', 'USD'])
  })

  test('按天分组', () => {
    const s = fresh()
    const now = Date.now()
    recordUsage(s, entry({ occurredAt: now }))
    recordUsage(s, entry({ occurredAt: now - 2 * DAY }))
    expect(usageBy(s, 'day')).toHaveLength(2)
    s.close()
  })

  test('按 kind 分组能把摘要开销单列出来', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'run', runId: 'rn_1' }))
    recordUsage(s, entry({ kind: 'summary' }))
    expect(
      usageBy(s, 'kind')
        .map((r) => r.key)
        .sort(),
    ).toEqual(['run', 'summary'])
    s.close()
  })

  test('没有 workspace 的归到「(无)」而不是被丢掉', () => {
    const s = fresh()
    recordUsage(s, entry({ workspaceId: null }))
    expect(usageBy(s, 'workspace')[0]!.key).toBe('(无)')
    s.close()
  })

  test('分组里的缓存口径与总计一致（未回报仍是 null）', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'm', cachedTokens: null }))
    expect(usageBy(s, 'model')[0]!.cachedTokens).toBeNull()
    s.close()
  })
})

describe('清账', () => {
  test('只删指定时间之前的', () => {
    const s = fresh()
    recordUsage(s, entry({ occurredAt: 1000 }))
    recordUsage(s, entry({ occurredAt: 5000 }))
    expect(pruneUsage(s, 3000)).toBe(1)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })
})

/**
 * 记账失败的可见性。
 *
 * 这一组是被一次静默失败逼出来的：给 `kind` 加了新值却忘了 schema 上的 CHECK 约束，
 * 插入直接抛，而 `catch {}` 把它和「重复记账」一起吞了。
 * 现象是功能全部正常、账本一行没有、哪里都不报错——最难查的那种。
 */
describe('记账失败要说出来', () => {
  test('新的 kind 能记进去 —— CHECK 约束跟着 TS 类型一起放开了', () => {
    const store = new Store({ path: ':memory:' })
    const ok = recordUsage(store, {
      kind: 'classifier',
      model: 'm',
      provider: 'openai_chat_completions',
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.0001,
    })
    expect(ok).toBe(true)
    expect(usageTotals(store, { kind: 'classifier' }).entries).toBe(1)
    store.close()
  })

  /** 重复记账仍然要被挡住，而且**安静地**挡住——那是这个 catch 本来的用途。 */
  test('同一个 run 重复记账返回 false，不刷屏', () => {
    const store = new Store({ path: ':memory:' })
    const entry = {
      kind: 'run' as const,
      runId: 'rn_dup',
      model: 'm',
      provider: 'anthropic' as const,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0,
    }
    expect(recordUsage(store, entry)).toBe(true)
    expect(recordUsage(store, entry)).toBe(false)
    expect(usageTotals(store, {}).entries).toBe(1)
    store.close()
  })

  /**
   * 不是唯一冲突的失败要打到 stderr。
   *
   * 断言的是「说出来了」而不是具体文案——文案会改，而「静默」是那个真正的 bug。
   */
  test('非冲突的失败会打到 stderr', () => {
    const store = new Store({ path: ':memory:' })
    const original = process.stderr.write.bind(process.stderr)
    let said = ''
    process.stderr.write = ((chunk: string) => {
      said += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      recordUsage(store, {
        kind: '不存在的种类' as never,
        model: 'm',
        provider: 'anthropic',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
      })
    } finally {
      process.stderr.write = original
    }
    expect(said).toContain('记账失败')
    store.close()
  })
})

/**
 * 「这条会话花了多少」。
 *
 * 界面上这个数**必须含压缩摘要那几笔**：摘要是这条会话引发的、也计费，只是它不属于
 * 任何一轮。把 run 加起来是漏账，压缩越频繁漏得越多，而漏掉的部分在界面上无处可查。
 */
describe('按会话结账', () => {
  test('合计含非轮次的那几笔，且只算这条会话', () => {
    const store = new Store({ path: ':memory:' })
    recordUsage(store, entry({ conversationId: 'cv_a', runId: 'run_1', cost: 0.01 }))
    recordUsage(store, entry({ kind: 'summary', conversationId: 'cv_a', cost: 0.004 }))
    recordUsage(store, entry({ conversationId: 'cv_b', runId: 'run_2', cost: 0.5 }))

    const a = usageTotals(store, { conversationId: 'cv_a' })
    expect(a.entries).toBe(2)
    expect(a.cost.USD).toBeCloseTo(0.014, 6)

    // 清单要能把那一笔单独摆出来，否则合计比清单大而看不出差在哪。
    const rows = usageEntries(store, { conversationId: 'cv_a' })
    expect(rows.map((r) => r.kind).sort()).toEqual(['run', 'summary'])
    expect(rows.find((r) => r.kind === 'summary')?.runId).toBe(null)
    store.close()
  })

  test('一笔都没回报过缓存写入时是 null，不是 0', () => {
    const store = new Store({ path: ':memory:' })
    recordUsage(store, entry({ conversationId: 'cv_c', cacheWriteTokens: null }))
    expect(usageTotals(store, { conversationId: 'cv_c' }).cacheWriteTokens).toBe(null)
    recordUsage(store, entry({ conversationId: 'cv_c', runId: 'run_9', cacheWriteTokens: 7 }))
    expect(usageTotals(store, { conversationId: 'cv_c' }).cacheWriteTokens).toBe(7)
    store.close()
  })
})

describe('摘要长度统计', () => {
  test('已回报的 in-run summary 请求与手动账本摘要各算一次样本', () => {
    const store = fresh()
    const workspace = upsertWorkspace(store, '/tmp/summary-percentile', 'summary-percentile')
    const conversation = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'p',
      model: 'm',
    })
    const run = createRun(store, {
      conversationId: conversation.id,
      workspaceId: workspace.id,
      model: 'm',
      clientRequestId: 'summary-percentile',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const request = openProviderRequest(store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      purpose: 'summary',
      model: 'm',
      measuredInputTokens: 1,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'summary-percentile',
    })
    settleProviderRequest(store, request.id, 'received', {
      inputTokens: 1,
      outputTokens: 300,
      cachedTokens: null,
      cacheWriteTokens: null,
    })
    recordUsage(
      store,
      entry({ kind: 'summary', workspaceId: workspace.id, outputTokens: 100, runId: null }),
    )

    expect(summaryOutputPercentile(store, workspace.id, 0)).toBe(100)
    expect(summaryOutputPercentile(store, workspace.id, 0.99)).toBe(300)
    store.close()
  })
})

describe('使用统计（逐日序列与连续天数）', () => {
  const DAY = 86_400_000

  /**
   * 与 SQL 的 localtime 分组同口径：本地日 'YYYY-MM-DD'。
   *
   * **不能只用 `new Date(ts)`**：`bun test` 进程里 JS 的 Date 走 UTC，而 SQLite 的
   * localtime 按系统时区（Windows 上 TZ 环境变量不生效）——东八区 0–8 点之间两个
   * 口径差一天，这类测试在那几小时必红。偏移从 SQLite 自己探，探到的是系统真实时区。
   */
  let systemOffsetMs: number | null = null
  function localDate(ts: number): string {
    if (systemOffsetMs === null) systemOffsetMs = probeSystemOffsetMs()
    const d = new Date(ts + systemOffsetMs)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  function probeSystemOffsetMs(): number {
    const probe = fresh()
    const row = probe.db
      .query("SELECT strftime('%s','now','localtime') - strftime('%s','now','utc') AS off")
      .get() as { off: number | null }
    probe.close()
    return Math.round((row.off ?? 0) * 1000)
  }

  test('逐日总量含缓存命中，本地日分组', () => {
    const s = fresh()
    const now = Date.now()
    recordUsage(s, entry({ occurredAt: now, inputTokens: 100, outputTokens: 50, cachedTokens: 10 }))
    recordUsage(s, entry({ occurredAt: now, inputTokens: 1, outputTokens: 2, cachedTokens: null }))
    recordUsage(
      s,
      entry({ occurredAt: now - DAY, inputTokens: 7, outputTokens: 0, cachedTokens: 3 }),
    )
    const daily = usageDaily(s)
    expect(daily).toEqual([
      { date: localDate(now - DAY), tokens: 10 },
      { date: localDate(now), tokens: 163 },
    ])
    s.close()
  })

  test('逐日分模型：同一日多模型各自成行', () => {
    const s = fresh()
    const now = Date.now()
    recordUsage(
      s,
      entry({
        occurredAt: now,
        model: 'model-a',
        inputTokens: 40,
        outputTokens: 0,
        cachedTokens: null,
      }),
    )
    recordUsage(
      s,
      entry({
        occurredAt: now,
        model: 'model-b',
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: null,
      }),
    )
    const rows = usageDailyByModel(s)
    expect(rows).toEqual([
      { date: localDate(now), model: 'model-a', tokens: 40 },
      { date: localDate(now), model: 'model-b', tokens: 3 },
    ])
    s.close()
  })

  test('最长单轮时长取 finished_at - created_at，未跑完的不算', () => {
    const s = fresh()
    s.db.exec(
      "INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES ('ws_1', 'w', '/w', 0, 0)",
    )
    s.db.exec(
      `INSERT INTO conversations (id, workspace_id, title, model, cache_generation, created_at, updated_at)
       VALUES ('cv_1', 'ws_1', '', 'm', 0, 0, 0)`,
    )
    const run = (id: string, created: number, finished: number | null) => {
      s.db
        .query(
          `INSERT INTO runs (id, conversation_id, workspace_id, model, client_request_id, status,
                             created_at, finished_at)
           VALUES (?, 'cv_1', 'ws_1', 'm', ?,
                   ?, ?, ?)`,
        )
        .run(id, `${id}-c`, finished === null ? 'running' : 'done', created, finished)
    }
    run('run_1', 1_000, 61_000)
    run('run_2', 5_000, 25_000)
    run('run_3', 1_000, null)
    expect(usageLongestRunMs(s)).toBe(60_000)
    s.close()
  })

  test('连续天数：今天没数据按昨天锚定，断开归零', () => {
    const now = Date.now()
    const d0 = localDate(now)
    const d1 = localDate(now - DAY)
    const d2 = localDate(now - 2 * DAY)
    const d5 = localDate(now - 5 * DAY)
    const d6 = localDate(now - 6 * DAY)

    expect(usageStreaks([])).toEqual({ current: 0, longest: 0 })
    // today 与 localDate 同口径（SQL 探出的系统本地日）。
    const today = localDate(Date.now())
    // 今天 + 昨天 + 前天 + 5 天前 + 6 天前：当前 3 天（断在 4 天前），最长 3 天。
    expect(usageStreaks([d5, d0, d2, d1, d6], today)).toEqual({ current: 3, longest: 3 })
    // 没有今天的记录时，昨天开始数；昨天也没有就断。
    expect(usageStreaks([d1, d2], today)).toEqual({ current: 2, longest: 2 })
    expect(usageStreaks([d5, d6], today)).toEqual({ current: 0, longest: 2 })
  })
})
