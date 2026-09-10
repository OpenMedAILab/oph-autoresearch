/** Feishu REST transport and notification cards; credentials never enter the queue. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { RemoteChannelConfig } from './remote-channels.ts'
import type {
  ResearchNotificationAdapter,
  ResearchNotificationPayload,
} from './research-notifications.ts'

export type WorkflowBinding = NonNullable<ResearchNotificationPayload['workflow']> & {
  chatId: string
}
const bindingText = (binding: WorkflowBinding) =>
  JSON.stringify([
    binding.chatId,
    binding.conversationId,
    binding.workflowId,
    binding.checkpointId,
    binding.reviewStepId,
  ])
export function signBinding(binding: WorkflowBinding, secret: string) {
  return {
    ...binding,
    signature: createHmac('sha256', secret).update(bindingText(binding)).digest('hex'),
  }
}
export function verifyBinding(value: unknown, secret: string): WorkflowBinding | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    !['chatId', 'conversationId', 'workflowId', 'checkpointId', 'reviewStepId'].every(
      (key) => typeof row[key] === 'string' && row[key],
    )
  )
    return null
  if (typeof row.signature !== 'string' || !/^[a-f0-9]{64}$/.test(row.signature)) return null
  const binding = row as unknown as WorkflowBinding
  const expected = signBinding(binding, secret).signature
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.signature, 'hex'))
    ? binding
    : null
}

export class FeishuClient {
  private token: { value: string; expiresAt: number } | undefined
  constructor(
    private readonly config: Pick<RemoteChannelConfig, 'appId' | 'secretEnv'>,
    private readonly http: typeof fetch = fetch,
  ) {}
  secret(): string {
    const secret = process.env[this.config.secretEnv]
    if (!secret) throw new Error('feishu_missing_credential')
    return secret
  }
  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    const response = await this.http(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.secret() }),
      },
    )
    const body = (await response.json()) as {
      code?: number
      tenant_access_token?: string
      expire?: number
    }
    if (!response.ok || body.code !== 0 || !body.tenant_access_token)
      throw new Error('feishu_auth_failed')
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(0, (body.expire ?? 0) - 60) * 1000,
    }
    return this.token.value
  }
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    signal = AbortSignal.timeout(10_000),
  ): Promise<Record<string, unknown>> {
    const token = await this.accessToken(signal)
    const response = await this.http(`https://open.feishu.cn/open-apis/${path}`, {
      method,
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok || data.code !== 0) {
      if ([99991661, 99991663, 99991668].includes(Number(data.code))) this.token = undefined
      throw new Error('feishu_request_failed')
    }
    return data
  }
  async send(
    recipient: string,
    type: 'chat_id' | 'open_id',
    content: unknown,
    msgType: 'text' | 'interactive',
    key: string,
    signal?: AbortSignal,
    replyTo?: string,
  ): Promise<void> {
    const data = {
      msg_type: msgType,
      content: JSON.stringify(content),
      uuid: createHash('sha256').update(key).digest('hex').slice(0, 32),
    }
    await this.request(
      replyTo
        ? `im/v1/messages/${encodeURIComponent(replyTo)}/reply`
        : `im/v1/messages?receive_id_type=${type}`,
      'POST',
      replyTo ? { ...data, reply_in_thread: true } : { ...data, receive_id: recipient },
      signal,
    )
  }
}

export function notificationCard(
  payload: ResearchNotificationPayload,
  link: string,
  binding?: ReturnType<typeof signBinding>,
) {
  const title =
    payload.kind === 'human_checkpoint'
      ? '等待人类决策'
      : payload.kind === 'job_finished'
        ? `实验作业：${payload.job?.state}`
        : `科研通知：${payload.kind}`
  const elements: unknown[] = [{ tag: 'markdown', content: title }]
  if (payload.checkpointDetails) {
    const details = payload.checkpointDetails
    // Plain text keeps model-authored summaries from creating links or mentions in the card.
    const content = [
      details.checks.length
        ? `核验清单\n${details.checks.map((check) => `• ${check}`).join('\n')}`
        : '',
      ...details.analyses.map(
        (analysis) =>
          `分析建议：${({ accept: '接受', iterate: '迭代', stop: '停止' } as Record<string, string>)[analysis.decision] ?? analysis.decision}\n${analysis.summary}${analysis.nextExperiment ? `\n下一步：${analysis.nextExperiment}` : ''}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    if (content)
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: content.slice(0, 6000) } })
  }
  if (payload.workflow)
    elements.push({
      tag: 'markdown',
      content: `工作流：${payload.workflow.workflowId}\n检查点：${payload.workflow.checkpointId}`,
    })
  if (link)
    elements.push({
      tag: 'markdown',
      content: `[打开决策页](${link})\n仅同一局域网或已配置的安全网络可达；群链接需在已配对浏览器打开。`,
    })
  if (binding)
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '批准' },
              type: 'primary',
              behaviors: [{ type: 'callback', value: { binding, decision: 'approve' } }],
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '返工' },
              behaviors: [{ type: 'callback', value: { binding, decision: 'revise' } }],
            },
          ],
        },
      ],
    })
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title } },
    body: { elements },
  }
}

export function feishuAdapters(
  channel: RemoteChannelConfig,
  client: FeishuClient,
  link: (payload: ResearchNotificationPayload, paired: boolean) => string,
): ResearchNotificationAdapter[] {
  if (!channel.enabled || !process.env[channel.secretEnv]) return []
  return (channel.chatId ? [channel.chatId] : channel.allowFrom).map((recipient) => ({
    channel: channel.id,
    recipient,
    enabled: true,
    async deliver({ deliveryKey, payload, signal }) {
      const binding =
        channel.chatId && payload.workflow
          ? signBinding({ ...payload.workflow, chatId: channel.chatId }, client.secret())
          : undefined
      await client.send(
        recipient,
        channel.chatId ? 'chat_id' : 'open_id',
        notificationCard(
          payload,
          link(payload, !channel.chatId && channel.controlLevel === 'control'),
          binding,
        ),
        'interactive',
        deliveryKey,
        signal,
      )
    },
  }))
}
