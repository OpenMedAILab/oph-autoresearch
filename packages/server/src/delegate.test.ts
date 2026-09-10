/**
 * 派一件的进度通道。**用假 provider 跑真链路，不花钱、不联网。**
 *
 * 覆盖范围：`delegate.ts` 的 `makeDelegate().run()` 广播出来的 `team.member`
 * ——内置分支的完整序列、终态里的子会话 id、拿不到卡片 id 时的降级、
 * 以及派不出去时不留半截状态。
 *
 * **为什么走真链路。** 这条通道的形状就是「派出去之后，卡上那一格跟着动」。
 * 把 `runBuiltinMember` 换成桩，测到的只是「桩被调用了」；真正会坏的是装配——
 * 事件带没带 stepId（不带前端整条丢弃）、终态发没发（不发那一格永远停在进行中）、
 * 子会话 id 有没有随终态出来（没有就点不开）。
 *
 * 外部 CLI 那一支这里覆盖不到：`findCli` 探测的是本机装了什么，测试环境不可控。
 * 它由真机验收。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventDispatcher } from '@larksuiteoapi/node-sdk'
import type { ToolContext } from '@oph-autoresearch/agent'
import type { AgentEvent, ConversationId, EventEnvelope, RunId } from '@oph-autoresearch/core'
import { foldWorkflow } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  appendMessage,
  appendStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  getConversation,
  listMessages,
  listRuns,
  listSteps,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { EventBus } from './bus.ts'
import { createFeishuService } from './channels/service.ts'
import { makeDelegate, workflowRecords } from './delegate.ts'
import { saveRemoteChannels } from './remote-channels.ts'
import { ResearchNotificationCoordinator } from './research-notifications.ts'
import { RunManager } from './runs.ts'
import { serve } from './server.ts'
import { decideWorkflow } from './workflow-decisions.ts'

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 一轮纯文本收尾：子 agent 说完这句就结束，产出就是它。 */
function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_text' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_text',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

/** 这次请求怎么答。用完就 401——那一档当场终结，不会让子会话自己接着转。 */
let script: (() => Response)[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text()
    const next = script.shift()
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next()
  },
})

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let config: OphConfig
let workspaceId = ''
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oph-autoresearch-delegate-'))
  const dbPath = join(dir, 'delegate.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  runs = new RunManager(store, bus)
  config = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  } as unknown as OphConfig
  workspaceId = upsertWorkspace(store, dir, 'delegate-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => events.push(frame),
  })
})

afterAll(async () => {
  provider.stop(true)
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** 每个用例一条干净的会话与一份干净的脚本。 */
function conversation(): ConversationId {
  script = []
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '派活',
  }).id
}

function delegate(conversationId: ConversationId) {
  return makeDelegate({
    deps: { store, content, config, bus, runs },
    workspaceRoot: dir,
    conversationId,
  })
}

function seedWaitingWorkflow(
  parent: ConversationId,
  child: ConversationId,
  key: string,
  reviewer?: 'human',
  next = false,
) {
  const run = createRun(store, {
    conversationId: parent,
    workspaceId: workspaceId as never,
    model: 'deepseek-v4-flash',
    clientRequestId: `workflow-${key}`,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const args = {
    goal: '形成可靠结论',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'ad-hoc', task: '研究并给出证据' },
      {
        id: 'review',
        kind: 'checkpoint',
        label: '主会话审查',
        needs: ['a'],
        ...(reviewer ? { reviewer } : {}),
      },
      ...(next ? [{ id: 'b', agent: 'ad-hoc', task: '批准后执行', needs: ['review'] }] : []),
    ],
  }
  const step = appendStep(store, {
    runId: run.id,
    seq: 1,
    kind: 'tool_action',
    toolName: 'workflow',
    toolCallId: `call_${key}`,
    status: 'running',
    payload: { kind: 'tool_call', args },
  })
  settleToolStep(store, step.id, 'success', {
    kind: 'tool_result',
    args,
    outcome: {
      status: 'success',
      executed: true,
      message: '等待审查',
      data: {
        workflowId: step.id,
        phase: 'waiting_review',
        checkpointId: 'review',
        receipts: [
          {
            nodeId: 'a',
            agent: 'ad-hoc',
            label: '临时子 agent',
            status: 'done',
            output: '初稿',
            durationMs: 5,
            conversationId: child,
          },
        ],
      },
    },
  })
  return step
}

/**
 * 广播出去的成员事件，按顺序。
 *
 * 成员类型按 `type` 收窄拿到——`@oph-autoresearch/core` 刻意不逐个导出事件成员，
 * 它们只在 `AgentEvent` 这个可辨识联合里出现。
 */
type MemberEvent = Extract<AgentEvent, { type: 'team.member' }>

function members(): MemberEvent[] {
  return events.map((f) => f.event).filter((e): e is MemberEvent => e.type === 'team.member')
}

const at = { runId: 'rn_1' as RunId, stepId: 'st_1' }

describe('派一件的进度', () => {
  test('跑成时按 working → done 走，都挂在这张卡上', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('查完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(true)
    expect(res.output).toBe('查完了')
    // 两条 `working`：交出去一条，子会话起来之后一条（那条带着它的 id）。
    // 前端按 memberId 原地更新，图上仍是一格。
    expect(members().map((m) => m.phase)).toEqual(['working', 'working', 'done'])
    // 不带 stepId 的事件前端认不出是哪张卡，整条丢弃。
    expect(members().every((m) => m.stepId === 'st_1')).toBe(true)
    expect(members().every((m) => m.runId === 'rn_1')).toBe(true)
  })

  /**
   * 子会话不进会话列表，这个 id 是点开它的唯一入口。
   *
   * **跑着的时候就得带上**，不能只在终态带：这是原始失败形状——只有终态带的话，
   * 子 agent 跑完之前那一格是灰的，而正在跑的那一格恰好是用户要翻开的。
   */
  test('跑着的时候那一格就带上子会话 id，终态照旧带着', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('看完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '看一眼',
      ...at,
      signal: new AbortController().signal,
    })

    const live = members()
      .filter((m) => m.phase === 'working')
      .at(-1)
    expect(live?.childConversationId).toBe(res.conversationId as ConversationId)
    expect(live?.childConversationId).toBeTruthy()
    expect(getConversation(store, res.conversationId as ConversationId)?.parentConversationId).toBe(
      cid,
    )

    const done = members().at(-1)
    expect(done?.phase).toBe('done')
    expect(done?.childConversationId).toBe(res.conversationId as ConversationId)
  })

  /**
   * 原始失败形状：子 agent 跑着时切到另一条会话，再切回来会从正在执行的 step 回放。
   * `team.member` 只活在订阅期，入口若等工具终态才落库，这张回放卡没有 id、节点被禁用。
   */
  test('父会话切走前，运行中的 step 已经落下子会话入口', async () => {
    const cid = conversation()
    const run = createRun(store, {
      conversationId: cid,
      workspaceId: workspaceId as never,
      model: 'deepseek-v4-flash',
      clientRequestId: `early-child-${cid}`,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: `call_${cid}`,
      status: 'running',
      payload: { kind: 'tool_call', args: { task: '看一眼' } },
    })
    script = [() => new Response(textTurn('看完了'), { headers: SSE_HEADERS })]

    const res = await delegate(cid).run({
      target: '',
      task: '看一眼',
      runId: run.id,
      stepId: step.id,
      signal: new AbortController().signal,
    })

    // 外层工具循环尚未 settle：这里就是切换父会话时会读到的形状。
    const replay = listSteps(store, run.id).find((s) => s.id === step.id)
    expect(replay?.status).toBe('running')
    const payload = replay?.payload
    expect(payload?.kind).toBe('tool_call')
    expect(payload?.kind === 'tool_call' ? payload.childConversationId : undefined).toBe(
      res.conversationId as ConversationId | undefined,
    )
  })

  /**
   * 子会话的事件按**它自己的会话 id** 广播。右侧那一页订阅的就是这个 id——
   * 不发的话它在子 agent 跑完之前一个字都画不出来。
   *
   * 归属必须是子会话，不能是父会话：那些 runId 在父会话里不存在，
   * 挂过去前端会按陌生 runId 建出一条并不存在的 run。
   */
  test('子会话的事件按它自己的 id 发出去，不挂在父会话上', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('看完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '看一眼',
      ...at,
      signal: new AbortController().signal,
    })

    const child = res.conversationId as ConversationId
    const inner = events.filter((f) => f.conversationId === child)
    expect(inner.map((f) => f.event.type)).toContain('run.started')
    expect(inner.map((f) => f.event.type)).toContain('run.finished')
    // 父会话那条上只有图卡进度，没有子会话的内层事件。
    expect(
      events
        .filter((f) => f.conversationId === cid)
        .every((f) => f.event.type === 'team.member' || f.event.type === 'team.output'),
    ).toBe(true)
  })

  /**
   * 没做成也必须落终态。**这是原始失败形状**：不发的话卡上那一格停在「进行中」，
   * 而这一轮早就结束了——用户看到的是一个永远转下去的格子。
   */
  test('没做成时落 failed，不是停在 working', async () => {
    const cid = conversation()
    // 脚本空着 = 401，子会话当场终结。
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(false)
    expect(members().map((m) => m.phase)).toEqual(['working', 'working', 'failed'])
  })

  /** 中断走的也是终态那条路：用户点停止之后，那一格不能还转着。 */
  test('中断时也落 failed', async () => {
    const cid = conversation()
    const ctl = new AbortController()
    ctl.abort()
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: ctl.signal,
    })

    expect(res.ok).toBe(false)
    expect(members().map((m) => m.phase)).toEqual(['working', 'working', 'failed'])
  })

  /**
   * 拿不到卡片 id 时整条不发。发出去也没有卡片认领它（前端按 stepId 找），
   * 只是白广播——而派活本身照跑，形状与终态都不依赖这条通道。
   */
  test('没有卡片 id 时一条都不发，活照派', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('查完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      runId: 'rn_2' as RunId,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(true)
    expect(members()).toHaveLength(0)
  })

  /** 派不出去就不该在图上留一个跑着的格子——那一格从头到尾没人在跑。 */
  test('目标不存在时不发任何进度', async () => {
    const cid = conversation()
    const res = await delegate(cid).run({
      target: '查无此角色',
      task: '执行任务',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(false)
    expect(members()).toHaveLength(0)
  })
})

describe('workflow 从父会话账本续接', () => {
  test('revise 读回首轮回执，并把二次指令发进同一个子会话', async () => {
    const parent = conversation()
    const child = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      title: '节点 a',
      source: 'workflow',
      sourceRef: 'ad-hoc',
      parentConversationId: parent,
    })
    appendMessage(store, { conversationId: child.id, role: 'user', content: '先给一个初稿' })
    appendMessage(store, {
      conversationId: child.id,
      role: 'assistant',
      content: '初稿：只有一个来源',
    })
    const hiddenBefore = store.db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM conversations WHERE source = 'workflow'",
      )
      .get()?.count

    const run = createRun(store, {
      conversationId: parent,
      workspaceId: workspaceId as never,
      model: 'deepseek-v4-flash',
      clientRequestId: 'workflow-seed',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const first = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_workflow_seed',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: {
          goal: '形成可靠结论',
          nodes: [
            { id: 'a', kind: 'agent', agent: 'ad-hoc', task: '研究并给出证据' },
            { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
          ],
        },
      },
    })
    settleToolStep(store, first.id, 'success', {
      kind: 'tool_result',
      args: {
        goal: '形成可靠结论',
        nodes: [
          { id: 'a', kind: 'agent', agent: 'ad-hoc', task: '研究并给出证据' },
          { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
        ],
      },
      outcome: {
        status: 'success',
        executed: true,
        message: '等待审查',
        data: {
          workflowId: first.id,
          phase: 'waiting_review',
          checkpointId: 'review',
          receipts: [
            {
              nodeId: 'a',
              agent: 'ad-hoc',
              label: '临时子 agent',
              status: 'done',
              output: '初稿：只有一个来源',
              durationMs: 5,
              conversationId: child.id,
            },
          ],
        },
      },
    })

    script = [() => new Response(textTurn('修订稿：已经补充两条证据'), { headers: SSE_HEADERS })]
    const result = await delegate(parent).runGraph({
      call: {
        kind: 'review',
        workflowId: first.id,
        checkpointId: 'review',
        decision: 'revise',
        note: '证据不足',
        revisions: [{ nodeId: 'a', instruction: '补充两条可核验证据' }],
      },
      runId: 'rn_review',
      stepId: 'st_review',
      signal: new AbortController().signal,
    })

    expect(result.ok).toBe(true)
    expect(result.transition?.phase).toBe('waiting_review')
    expect(result.transition?.review?.decision).toBe('revise')
    expect(result.transition?.receipts[0]?.conversationId).toBe(child.id)
    expect(result.transition?.receipts[0]?.output).toBe('修订稿：已经补充两条证据')
    const messages = listMessages(store, child.id)
    expect(messages.filter((message) => message.role === 'user').at(-1)?.content).toContain(
      '补充两条可核验证据',
    )
    const resumedRun = listRuns(store, child.id).at(-1)
    expect(
      resumedRun
        ? listSteps(store, resumedRun.id)
            .filter((step) => step.kind === 'text')
            .map((step) => step.content)
            .join('')
        : '',
    ).toBe('修订稿：已经补充两条证据')
    const hidden = store.db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM conversations WHERE source = 'workflow'",
      )
      .get()
    expect(hidden?.count).toBe(hiddenBefore)
  })

  test('普通会话不能被伪装成 workflow 子节点续接', async () => {
    const parent = conversation()
    const ordinary = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      title: '普通会话',
    })
    const first = seedWaitingWorkflow(parent, ordinary.id, 'ordinary-child')
    const result = await delegate(parent).runGraph({
      call: {
        kind: 'review',
        workflowId: first.id,
        checkpointId: 'review',
        decision: 'revise',
        note: '返工',
        revisions: [{ nodeId: 'a', instruction: '继续' }],
      },
      runId: 'rn_bad_child',
      stepId: 'st_bad_child',
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    expect(result.transition?.receipts[0]?.status).toBe('failed')
    expect(result.transition?.receipts[0]?.error).toContain('不属于当前工作流节点')
    expect(result.transition?.receipts[0]?.conversationId).toBe(ordinary.id)
    expect(listRuns(store, ordinary.id)).toHaveLength(0)
  })

  test('另一父会话的同角色子节点不能续接', async () => {
    const parent = conversation()
    const otherParent = conversation()
    const child = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      title: '另一张图的节点 a',
      source: 'workflow',
      sourceRef: 'ad-hoc',
      parentConversationId: otherParent,
    })
    const first = seedWaitingWorkflow(parent, child.id, 'foreign-parent')
    const result = await delegate(parent).runGraph({
      call: {
        kind: 'review',
        workflowId: first.id,
        checkpointId: 'review',
        decision: 'revise',
        note: '返工',
        revisions: [{ nodeId: 'a', instruction: '继续' }],
      },
      runId: 'rn_foreign_parent',
      stepId: 'st_foreign_parent',
      signal: new AbortController().signal,
    })

    expect(result.ok).toBe(false)
    expect(result.transition?.receipts[0]?.status).toBe('failed')
    expect(result.transition?.receipts[0]?.error).toContain('不属于当前工作流节点')
    expect(result.transition?.receipts[0]?.conversationId).toBe(child.id)
    expect(listRuns(store, child.id)).toHaveLength(0)
  })

  test('start → revise → approve 下一批 → approve 完成全程从同一父账本推进', async () => {
    const parent = conversation()
    const run = createRun(store, {
      conversationId: parent,
      workspaceId: workspaceId as never,
      model: 'deepseek-v4-flash',
      clientRequestId: 'workflow-full-loop',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const nodes = [
      { id: 'a', kind: 'agent' as const, agent: 'ad-hoc', task: '第一批 A' },
      { id: 'b', kind: 'agent' as const, agent: 'ad-hoc', task: '第一批 B' },
      { id: 'cp1', kind: 'checkpoint' as const, label: '审查第一批', needs: ['a', 'b'] },
      { id: 'c', kind: 'agent' as const, agent: 'ad-hoc', task: '第二批 C', needs: ['cp1'] },
      { id: 'd', kind: 'agent' as const, agent: 'ad-hoc', task: '第二批 D', needs: ['cp1'] },
      { id: 'cp2', kind: 'checkpoint' as const, label: '最终审查', needs: ['c', 'd'] },
    ]
    const invoke = async (
      seq: number,
      args: Record<string, unknown>,
      call: Parameters<NonNullable<ToolContext['delegate']>['runGraph']>[0]['call'],
    ) => {
      const step = appendStep(store, {
        runId: run.id,
        seq,
        kind: 'tool_action',
        toolName: 'workflow',
        toolCallId: `call_full_${seq}`,
        status: 'running',
        payload: { kind: 'tool_call', args },
      })
      const result = await delegate(parent).runGraph({
        call,
        runId: run.id,
        stepId: step.id,
        signal: new AbortController().signal,
      })
      if (!result.transition) throw new Error(result.error ?? '没有 transition')
      settleToolStep(store, step.id, result.ok ? 'success' : 'failure', {
        kind: 'tool_result',
        args,
        outcome: {
          status: result.ok ? 'success' : 'failure',
          executed: true,
          message: result.transition.phase,
          data: result.transition as unknown as Record<string, unknown>,
        },
      })
      return { step, result }
    }

    script = [
      () => new Response(textTurn('第一批结果 1'), { headers: SSE_HEADERS }),
      () => new Response(textTurn('第一批结果 2'), { headers: SSE_HEADERS }),
      () => new Response(textTurn('A 的修订结果'), { headers: SSE_HEADERS }),
      () => new Response(textTurn('第二批结果 1'), { headers: SSE_HEADERS }),
      () => new Response(textTurn('第二批结果 2'), { headers: SSE_HEADERS }),
    ]
    const first = await invoke(
      1,
      { goal: '两批完成', nodes },
      { kind: 'start', goal: '两批完成', nodes, maxConcurrent: 4 },
    )
    expect(first.result.transition?.phase).toBe('waiting_review')
    expect(first.result.transition?.checkpointId).toBe('cp1')
    expect(first.result.transition?.receipts.map((receipt) => receipt.nodeId).sort()).toEqual([
      'a',
      'b',
    ])
    const firstA = first.result.transition?.receipts.find((receipt) => receipt.nodeId === 'a')
    expect(
      getConversation(store, firstA?.conversationId as ConversationId)?.parentConversationId,
    ).toBe(parent)

    const reviseArgs = {
      workflowId: first.step.id,
      checkpointId: 'cp1',
      decision: 'revise' as const,
      note: 'A 需要修订',
      revisions: [{ nodeId: 'a', instruction: '纠正 A' }],
    }
    const revised = await invoke(2, reviseArgs, { kind: 'review', ...reviseArgs })
    expect(revised.result.transition?.phase).toBe('waiting_review')
    expect(revised.result.transition?.receipts.map((receipt) => receipt.nodeId)).toEqual(['a'])
    expect(revised.result.transition?.receipts[0]?.conversationId).toBe(firstA?.conversationId)

    const approveFirstArgs = {
      workflowId: first.step.id,
      checkpointId: 'cp1',
      decision: 'approve' as const,
      note: '第一批通过',
    }
    const secondBatch = await invoke(3, approveFirstArgs, {
      kind: 'review',
      ...approveFirstArgs,
      revisions: [],
    })
    expect(secondBatch.result.transition?.phase).toBe('waiting_review')
    expect(secondBatch.result.transition?.checkpointId).toBe('cp2')
    expect(secondBatch.result.transition?.receipts.map((receipt) => receipt.nodeId).sort()).toEqual(
      ['c', 'd'],
    )

    const approveFinalArgs = {
      workflowId: first.step.id,
      checkpointId: 'cp2',
      decision: 'approve' as const,
      note: '最终通过',
    }
    const completed = await invoke(4, approveFinalArgs, {
      kind: 'review',
      ...approveFinalArgs,
      revisions: [],
    })
    expect(completed.result.transition?.phase).toBe('completed')
    expect(completed.result.transition?.receipts).toEqual([])
    expect(script).toHaveLength(0)
    const memberEvents = members()
    expect(
      memberEvents
        .filter((event) => event.memberId === 'c' || event.memberId === 'd')
        .every((event) => event.stepId === secondBatch.step.id),
    ).toBe(true)
    expect(listSteps(store, run.id).filter((step) => step.toolName === 'workflow')).toHaveLength(4)
  })
})

test('human checkpoint rejects model approval; authenticated HTTP continues the same graph exactly once', async () => {
  const parent = conversation()
  const child = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    source: 'workflow',
    sourceRef: 'ad-hoc',
    parentConversationId: parent,
  }).id
  const first = seedWaitingWorkflow(parent, child, 'human-decision', 'human', true)
  const denied = await delegate(parent).runGraph({
    call: {
      kind: 'review',
      workflowId: first.id,
      checkpointId: 'review',
      decision: 'approve',
      note: '模型同意',
      revisions: [],
    },
    origin: 'model',
    runId: first.runId,
    stepId: 'st_denied',
    signal: new AbortController().signal,
  })
  expect(denied).toMatchObject({ ok: false, errorKind: 'waiting_human' })
  expect(denied.transition).toBeUndefined()
  script = [() => new Response(textTurn('已执行批准后的节点'), { headers: SSE_HEADERS })]
  const server = serve({
    store,
    content,
    config,
    workspaceRoot: dir,
    host: '127.0.0.1',
    port: 0,
    token: 'human-test-token',
  })
  const command = {
    type: 'workflow.review',
    conversationId: parent,
    workflowId: first.id,
    checkpointId: 'review',
    expectedStepId: first.id,
    decision: 'approve',
    note: '实验员批准',
  }
  const request = (token: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    })
  try {
    expect((await request('invalid')).status).toBe(401)
    expect((await request('human-test-token')).status).toBe(202)
    expect((await request('human-test-token')).status).toBe(409)
    for (let i = 0; i < 100 && server.runs.isBusy(parent); i++) await Bun.sleep(10)
    expect(server.runs.isBusy(parent)).toBe(false)
    const folded = foldWorkflow(workflowRecords(store, parent), first.id)
    if (!folded.ok) throw new Error(folded.error)
    expect(folded.projection.phase).toBe('completed')
    expect(folded.projection.approvals.review).toContain('实验员批准')
    expect(folded.projection.results.b).toMatchObject({
      output: '已执行批准后的节点',
      provider: 'fake',
      model: 'deepseek-v4-flash',
    })
    expect((await request('human-test-token')).status).toBe(409)
  } finally {
    server.stop()
  }
})

test('human revision reuses the child, publishes a fresh checkpoint and rejects the previous card', async () => {
  const parent = conversation()
  const child = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    source: 'workflow',
    sourceRef: 'ad-hoc',
    parentConversationId: parent,
  }).id
  const initial = seedWaitingWorkflow(parent, child, 'human-revise', 'human')
  const deps = { store, content, config, bus, runs }
  const command = {
    type: 'workflow.review' as const,
    conversationId: parent,
    workflowId: initial.id,
    checkpointId: 'review',
    expectedStepId: initial.id,
    decision: 'revise' as const,
    note: '补充反例证据',
  }
  expect(decideWorkflow({ ...command, note: ' ' }, deps).ok).toBe(false)
  script = [() => new Response(textTurn('修订稿及反例'), { headers: SSE_HEADERS })]
  expect(decideWorkflow(command, deps).ok).toBe(true)
  for (let i = 0; i < 200 && runs.isBusy(parent); i++) await Bun.sleep(10)
  expect(runs.isBusy(parent)).toBe(false)
  const folded = foldWorkflow(workflowRecords(store, parent), initial.id)
  if (!folded.ok) throw new Error(folded.error)
  expect(folded.projection.phase).toBe('waiting_review')
  expect(folded.projection.results.a).toMatchObject({
    conversationId: child,
    output: '修订稿及反例',
  })
  expect(folded.projection.reviewStepId).not.toBe(initial.id)
  expect(
    events.some(
      ({ event }) =>
        event.type === 'team.member' &&
        event.phase === 'waiting_review' &&
        event.reviewer === 'human',
    ),
  ).toBe(true)
  expect(decideWorkflow({ ...command, decision: 'approve' }, deps).ok).toBe(false)
  expect(
    decideWorkflow(
      { ...command, decision: 'approve', expectedStepId: folded.projection.reviewStepId! },
      deps,
    ).ok,
  ).toBe(true)
  for (let i = 0; i < 200 && runs.isBusy(parent); i++) await Bun.sleep(10)
})

test('Feishu service reconciles checkpoints and replies only to its triggering main-conversation message', async () => {
  const parent = conversation()
  const unrelated = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  }).id
  const child = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    source: 'workflow',
    sourceRef: 'ad-hoc',
    parentConversationId: parent,
  }).id
  const checkpoint = seedWaitingWorkflow(parent, child, 'feishu-pending', 'human')
  const previousHome = process.env.OPH_AUTORESEARCH_HOME
  const previousSecret = process.env.OPH_TEST_FEISHU_SECRET
  process.env.OPH_AUTORESEARCH_HOME = await mkdtemp(join(dir, 'feishu-home-'))
  process.env.OPH_TEST_FEISHU_SECRET = 'fixture-secret'
  let dispatcher: EventDispatcher | undefined
  const sent: { url: string; body: { content?: string; msg_type?: string } }[] = []
  const http = (async (input: unknown, options?: RequestInit) => {
    const url = String(input)
    if (url.includes('tenant_access_token'))
      return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (url.includes('bot/v3')) return Response.json({ code: 0, bot: { open_id: 'bot' } })
    sent.push({ url, body: JSON.parse(String(options?.body ?? '{}')) })
    return Response.json({ code: 0 })
  }) as typeof fetch
  let service: ReturnType<typeof createFeishuService> | undefined
  let coordinator: ResearchNotificationCoordinator | undefined
  try {
    await saveRemoteChannels([
      {
        id: 'fixture',
        kind: 'feishu',
        name: 'fixture',
        enabled: true,
        appId: 'app',
        secretEnv: 'OPH_TEST_FEISHU_SECRET',
        allowFrom: ['human'],
        controlLevel: 'review',
        chatId: 'chat',
        conversationId: parent,
      },
    ])
    service = createFeishuService(
      { store, content, config, bus, runs },
      () => 'http://localhost/',
      {
        http,
        socketFactory: () => ({
          async start(input) {
            dispatcher = input.eventDispatcher
          },
          close() {},
        }),
      },
    )
    coordinator = new ResearchNotificationCoordinator({
      ownDbPath: join(dir, 'feishu-notify.sqlite'),
      adapters: service.adapters,
    })
    service.start(coordinator)
    for (let i = 0; i < 100 && !dispatcher; i++) await Bun.sleep(10)
    expect(dispatcher).toBeDefined()
    await coordinator.deliverDue()
    expect(coordinator.list(`conversation:${parent}`)).toMatchObject([
      { kind: 'human_checkpoint', eventId: `workflow:${checkpoint.id}:${checkpoint.id}` },
    ])
    const invoke = (id: string, text: string) =>
      dispatcher!.handles.get('im.message.receive_v1')!({
        sender: { sender_type: 'user', sender_id: { open_id: 'human' } },
        message: {
          message_id: id,
          chat_id: 'chat',
          chat_type: 'group',
          message_type: 'text',
          mentions: [{ key: '@_bot', id: { open_id: 'bot' } }],
          content: JSON.stringify({ text: `@_bot ${text}` }),
        },
      })
    script = [() => new Response(textTurn('主会话的最终答复'), { headers: SSE_HEADERS })]
    invoke('source-message', '讨论实验设计')
    invoke('source-message', '讨论实验设计')
    for (let i = 0; i < 200 && !sent.some((row) => row.url.endsWith('/source-message/reply')); i++)
      await Bun.sleep(10)
    expect(
      sent
        .filter((row) => row.url.endsWith('/source-message/reply'))
        .map((row) => JSON.parse(row.body.content!)),
    ).toEqual([{ text: '主会话的最终答复' }])
    const foreignRun = createRun(store, {
      conversationId: unrelated,
      workspaceId: workspaceId as never,
      model: 'deepseek-v4-flash',
      clientRequestId: 'foreign',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    bus.publish(
      {
        type: 'run.finished',
        runId: foreignRun.id,
        status: 'done',
        stopReason: 'completed',
        usage: foreignRun.usage,
        fileChanges: [],
      },
      unrelated,
    )
    await Bun.sleep(20)
    expect(sent.filter((row) => row.body.msg_type === 'text')).toHaveLength(1)
  } finally {
    service?.close()
    coordinator?.close()
    if (previousHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
    else process.env.OPH_AUTORESEARCH_HOME = previousHome
    if (previousSecret === undefined) delete process.env.OPH_TEST_FEISHU_SECRET
    else process.env.OPH_TEST_FEISHU_SECRET = previousSecret
  }
})

// Contracts run through the real member session and local scripted HTTP provider.
test('workflow output contracts fail at producer completion and suppress dependent nodes', async () => {
  const valid = {
    decision: 'iterate',
    summary: 'One more prespecified seed',
    findings: [],
    next_experiment: {
      changes: ['repeat seed'],
      rationale: 'Wide uncertainty',
      estimated_cost: 'unknown',
    },
    pitfalls_added: [],
    limitations: ['Small fixture'],
  }
  for (const [output, ok] of [
    [JSON.stringify(valid), true],
    [JSON.stringify({ decision: 'iterate' }), false],
    [`${JSON.stringify(valid)}\n${JSON.stringify(valid)}`, false],
    [JSON.stringify({ ...valid, next_experiment: null }), false],
  ] as const) {
    const cv = conversation()
    script = [
      () => new Response(textTurn(output), { headers: SSE_HEADERS }),
      () => new Response(textTurn('Reviewed'), { headers: SSE_HEADERS }),
    ]
    const result = await delegate(cv).runGraph!({
      call: {
        kind: 'start',
        goal: 'Contract regression',
        maxConcurrent: 1,
        nodes: [
          { id: 'analysis', agent: 'ad-hoc', task: 'Return analysis', outputKind: 'analysis' },
          { id: 'dependent', agent: 'ad-hoc', task: 'Review the analysis', needs: ['analysis'] },
          {
            id: 'human',
            kind: 'checkpoint',
            reviewer: 'human',
            label: 'Review',
            needs: ['dependent'],
            checks: ['Evidence is located'],
          },
        ],
      },
      runId: 'run_contract',
      stepId: 'step_contract',
      signal: new AbortController().signal,
    })
    expect(result.transition?.phase).toBe('waiting_review')
    expect(result.ok).toBe(ok)
    expect(result.transition?.receipts[1]?.status).toBe(ok ? 'done' : 'skipped')
    expect(result.transition?.receipts?.[0]?.status).toBe(ok ? 'done' : 'failed')
    if (ok) expect(result.transition?.receipts?.[0]?.structuredOutput).toEqual(valid)
    else expect(result.transition?.receipts?.[0]?.error).toContain('输出契约 analysis')
    expect(listRuns(store, cv)).toHaveLength(0)
  }
})
