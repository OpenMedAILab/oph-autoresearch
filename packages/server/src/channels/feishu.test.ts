/** Covers REST delivery, signed card references, inbound permissions and SDK lifecycle wiring. */
import { expect, test } from 'bun:test'
import {
  FeishuClient,
  feishuAdapters,
  notificationCard,
  signBinding,
  verifyBinding,
  type WorkflowBinding,
} from '../feishu-adapter.ts'
import type { RemoteChannelConfig } from '../remote-channels.ts'
import type { ResearchNotificationPayload } from '../research-notifications.ts'
import { FeishuConnection } from './feishu.ts'
import { type InboundMessage, routeInbound } from './route.ts'

const channel: RemoteChannelConfig = {
  id: 'test',
  kind: 'feishu',
  name: 'test',
  appId: 'app',
  secretEnv: 'OPH_TEST_FEISHU_SECRET',
  enabled: true,
  allowFrom: ['human'],
  controlLevel: 'review',
  chatId: 'chat',
  conversationId: 'cv',
}
const binding: WorkflowBinding = {
  chatId: 'chat',
  conversationId: 'cv',
  workflowId: 'wf',
  checkpointId: 'cp',
  reviewStepId: 'step',
}
const message: InboundMessage = { id: 'message', chatId: 'chat', text: '批准', binding }

test('whitelist and all three control levels govern chat, review and stop', () => {
  for (const level of ['chat', 'review', 'control'] as const) {
    const config = { ...channel, controlLevel: level }
    for (const text of ['讨论设计', '批准', '返工：补充证据', '停止']) {
      expect(routeInbound(config, 'stranger', { ...message, text })).toMatchObject({
        kind: 'reject',
        silent: true,
      })
      const expected =
        text === '讨论设计'
          ? 'chat'
          : text === '停止'
            ? level === 'control'
              ? 'interrupt'
              : 'reject'
            : level === 'chat'
              ? 'reject'
              : 'decision'
      expect(routeInbound(config, 'human', { ...message, text }).kind).toBe(expected)
    }
  }
  expect(routeInbound(channel, 'human', { id: 'msg', chatId: 'chat', text: '批准' }).kind).toBe(
    'chat',
  )
  expect(
    routeInbound(channel, 'human', {
      ...message,
      binding: { ...binding, conversationId: 'foreign' },
    }).kind,
  ).toBe('reject')
  expect(
    routeInbound(channel, 'human', { ...message, action: 'revise', text: '返工' }),
  ).toMatchObject({ kind: 'reject', reason: expect.stringContaining('具体意见') })
})

test('tampered binding cannot redirect a human decision', () => {
  const signed = signBinding(binding, 'secret')
  expect(verifyBinding(signed, 'secret')).toMatchObject(binding)
  expect(verifyBinding({ ...signed, workflowId: 'other' }, 'secret')).toBeNull()
  expect(verifyBinding(signed, 'other-secret')).toBeNull()
})

test('real adapter authenticates once, sends deduplicated cards and parses only bot-mentioned signed topics', async () => {
  const previous = process.env.OPH_TEST_FEISHU_SECRET
  process.env.OPH_TEST_FEISHU_SECRET = 'fixture-secret'
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = []
  let card: unknown
  const http = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input),
      body = options?.body ? JSON.parse(String(options.body)) : {}
    requests.push({ url, body, headers: new Headers(options?.headers) })
    if (url.includes('tenant_access_token'))
      return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (url.includes('bot/v3')) return Response.json({ code: 0, bot: { open_id: 'bot' } })
    if (url.endsWith('/im/v1/messages/card'))
      return Response.json({
        code: 0,
        data: {
          items: [
            { chat_id: 'chat', msg_type: 'interactive', body: { content: JSON.stringify(card) } },
          ],
        },
      })
    if (body.content) card = JSON.parse(body.content)
    return Response.json({ code: 0, data: { message_id: 'card' } })
  }) as typeof fetch
  const client = new FeishuClient(channel, http)
  const payload: ResearchNotificationPayload = {
    schema: 'research-notification-v1',
    deliveryKey: 'key',
    eventId: 'event',
    campaignId: 'campaign',
    campaignSeq: 0,
    occurredAt: 0,
    kind: 'human_checkpoint',
    campaign: { id: 'campaign', workspaceId: 'ws', stage: '', status: '' },
    conversationId: 'cv',
    workflow: binding,
  }
  const received: InboundMessage[] = []
  let closed = false
  const connection = new FeishuConnection(
    channel,
    client,
    async (_sender, input) => {
      received.push(input)
    },
    () => {},
    () => ({
      async start() {},
      close() {
        closed = true
      },
    }),
  )
  try {
    const adapter = feishuAdapters(channel, client, (_payload, paired) => {
      expect(paired).toBe(false)
      return 'http://localhost/m#workflow=wf'
    })[0]!
    await adapter.deliver({ deliveryKey: 'key', payload, signal: AbortSignal.timeout(1000) })
    await adapter.deliver({ deliveryKey: 'key', payload, signal: AbortSignal.timeout(1000) })
    expect(requests.filter((request) => request.url.includes('tenant_access_token'))).toHaveLength(
      1,
    )
    const sent = requests.filter((request) => request.body.msg_type === 'interactive')
    expect(sent[0]?.body.uuid).toBe(sent[1]?.body.uuid)
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer fixture-token')
    expect(JSON.stringify(card)).not.toContain('fixture-secret')
    expect(JSON.stringify(card)).not.toContain('fixture-token')
    await connection.start()
    const event = {
      sender: { sender_type: 'user', sender_id: { open_id: 'human' } },
      message: {
        message_id: 'msg',
        chat_id: 'chat',
        chat_type: 'group',
        message_type: 'text',
        parent_id: 'card',
        mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }],
        content: JSON.stringify({ text: '@_user_1 返工：补充反例' }),
      },
    }
    await connection.message(event)
    expect(received[0]).toMatchObject({ text: '返工：补充反例', binding })
    await connection.message({ ...event, message: { ...event.message, mentions: [] } })
    await connection.message({
      ...event,
      sender: { sender_type: 'user', sender_id: { open_id: 'stranger' } },
    })
    expect(received).toHaveLength(1)
    await connection.action({
      operator: { open_id: 'human' },
      context: { open_chat_id: 'chat', open_message_id: 'card' },
      action: { value: { binding: signBinding(binding, 'fixture-secret'), decision: 'approve' } },
    })
    expect(received[1]).toMatchObject({ action: 'approve', binding })
  } finally {
    connection.close()
    expect(closed).toBe(true)
    if (previous === undefined) delete process.env.OPH_TEST_FEISHU_SECRET
    else process.env.OPH_TEST_FEISHU_SECRET = previous
  }
})

test('Feishu renders the shared checklist and analysis as plain text', () => {
  const payload: ResearchNotificationPayload = {
    schema: 'research-notification-v1',
    deliveryKey: 'details',
    eventId: 'details',
    campaignId: 'campaign',
    campaignSeq: 0,
    occurredAt: 0,
    kind: 'human_checkpoint',
    campaign: { id: 'campaign', workspaceId: 'ws', stage: '', status: '' },
    workflow: binding,
    checkpointDetails: {
      checks: ['核对冻结方案'],
      analyses: [
        {
          nodeId: 'analysis',
          decision: 'iterate',
          summary: '<at id="all">not a mention</at>',
          nextExperiment: '增加一个随机种子；USD 2',
        },
      ],
    },
  }
  const card = JSON.stringify(notificationCard(payload, ''))
  expect(card).toContain('核对冻结方案')
  expect(card).toContain('分析建议：迭代')
  expect(card).toContain('增加一个随机种子')
  expect(card).toContain('plain_text')
})
