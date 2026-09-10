/** Official long connection transport; all business actions go through the command dispatcher. */
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { type FeishuClient, verifyBinding, type WorkflowBinding } from '../feishu-adapter.ts'
import type { RemoteChannelConfig } from '../remote-channels.ts'
import type { InboundMessage } from './route.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const parse = (value: unknown): unknown => {
  try {
    return JSON.parse(string(value))
  } catch {
    return null
  }
}

function cardBinding(value: unknown, secret: string): WorkflowBinding | null {
  const found = verifyBinding(value, secret)
  if (found) return found
  if (!value || typeof value !== 'object') return null
  for (const child of Object.values(value)) {
    const binding = cardBinding(child, secret)
    if (binding) return binding
  }
  return null
}

export class FeishuConnection {
  private socket: Pick<WSClient, 'start' | 'close'> | undefined
  private botId = ''
  private closed = false
  constructor(
    readonly channel: RemoteChannelConfig,
    readonly client: FeishuClient,
    private readonly receive: (sender: string, message: InboundMessage) => Promise<void>,
    private readonly status: (state: 'connecting' | 'connected' | 'failed' | 'disabled') => void,
    private readonly socketFactory: (
      options: ConstructorParameters<typeof WSClient>[0],
    ) => Pick<WSClient, 'start' | 'close'> = (options) => new WSClient(options),
  ) {}

  async start(): Promise<void> {
    this.status('connecting')
    try {
      const info = await this.client.request('bot/v3/info/')
      this.botId = string(record(info.bot).open_id)
      if (!this.botId) throw new Error('feishu_bot_identity_missing')
      if (this.closed) return
      this.socket = this.socketFactory({
        appId: this.channel.appId,
        appSecret: this.client.secret(),
        logger: {
          trace() {},
          debug() {},
          info() {},
          warn() {},
          error: () => this.status('failed'),
        },
        onReady: () => this.status('connected'),
        onError: () => this.status('failed'),
        onReconnecting: () => this.status('connecting'),
        onReconnected: () => this.status('connected'),
      })
      await this.socket.start({
        eventDispatcher: new EventDispatcher({}).register({
          'im.message.receive_v1': (event: unknown) => {
            void this.message(event).catch(() => this.status('failed'))
            return {}
          },
          'card.action.trigger': (event: unknown) => {
            void this.action(event).catch(() => this.status('failed'))
            return { toast: { type: 'info', content: '已收到，请查看群内回执' } }
          },
        }),
      })
    } catch {
      this.status('failed')
    }
  }

  async message(event: unknown): Promise<void> {
    const outer = record(event),
      data = outer.event ? record(outer.event) : outer
    const message = record(data.message),
      sender = record(data.sender)
    const openId = string(record(sender.sender_id).open_id)
    if (
      sender.sender_type !== 'user' ||
      !this.channel.allowFrom.includes(openId) ||
      message.chat_type !== 'group' ||
      message.chat_id !== this.channel.chatId ||
      message.message_type !== 'text'
    )
      return
    const mentions = Array.isArray(message.mentions) ? message.mentions.map(record) : []
    if (!mentions.some((mention) => record(mention.id).open_id === this.botId)) return
    let text = string(record(parse(message.content)).text)
    for (const mention of mentions)
      if (record(mention.id).open_id === this.botId && typeof mention.key === 'string')
        text = text.replaceAll(mention.key, '').trim()
    let binding: WorkflowBinding | null = null
    for (const reference of new Set(
      [string(message.parent_id), string(message.root_id)].filter(Boolean),
    )) {
      const response = await this.client.request(`im/v1/messages/${encodeURIComponent(reference)}`)
      const items = record(response.data).items
      if (!Array.isArray(items)) continue
      for (const item of items) {
        const row = record(item)
        if (row.chat_id !== this.channel.chatId || row.msg_type !== 'interactive') continue
        binding = cardBinding(parse(record(row.body).content), this.client.secret())
        if (binding) break
      }
      if (binding) break
    }
    const id = string(message.message_id)
    if (!id) return
    await this.receive(openId, {
      id,
      chatId: string(message.chat_id),
      text,
      ...(binding ? { binding } : {}),
    })
  }

  async action(event: unknown): Promise<void> {
    const outer = record(event),
      data = outer.event ? record(outer.event) : outer
    const sender = string(record(data.operator).open_id),
      context = record(data.context)
    if (!this.channel.allowFrom.includes(sender) || context.open_chat_id !== this.channel.chatId)
      return
    const value = record(record(data.action).value)
    const binding = verifyBinding(value.binding, this.client.secret())
    if (!binding || (value.decision !== 'approve' && value.decision !== 'revise')) return
    await this.receive(sender, {
      id: string(context.open_message_id),
      chatId: string(context.open_chat_id),
      text: value.decision === 'approve' ? '批准' : '返工',
      binding,
      action: value.decision,
    })
  }
  close(): void {
    this.closed = true
    this.socket?.close({ force: true })
    this.status('disabled')
  }
}
