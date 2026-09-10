/** Whitelist and control level are the sole inbound authorization policy. */

import type { WorkflowBinding } from '../feishu-adapter.ts'
import type { RemoteChannelConfig } from '../remote-channels.ts'

export interface InboundMessage {
  id: string
  chatId: string
  text: string
  binding?: WorkflowBinding
  action?: 'approve' | 'revise'
}
export type InboundRoute =
  | { kind: 'reject'; silent: boolean; reason: string }
  | { kind: 'chat'; conversationId: string; text: string }
  | { kind: 'interrupt'; conversationId: string }
  | { kind: 'decision'; binding: WorkflowBinding; decision: 'approve' | 'revise'; note: string }

export function routeInbound(
  channel: RemoteChannelConfig,
  sender: string,
  message: InboundMessage,
): InboundRoute {
  if (!channel.enabled || !channel.allowFrom.includes(sender) || message.chatId !== channel.chatId)
    return { kind: 'reject', silent: true, reason: '无权限' }
  const conversationId = message.binding?.conversationId ?? channel.conversationId
  if (
    !conversationId ||
    (message.binding &&
      (message.binding.chatId !== channel.chatId ||
        message.binding.conversationId !== channel.conversationId))
  )
    return { kind: 'reject', silent: false, reason: '话题不属于绑定的主会话' }
  const text = message.text.trim()
  if (text === '停止')
    return channel.controlLevel === 'control'
      ? { kind: 'interrupt', conversationId }
      : { kind: 'reject', silent: false, reason: '无停止权限' }
  const decision =
    message.action ??
    (message.binding && /^批准(?:\s|[：:]|$)/.test(text)
      ? 'approve'
      : message.binding && /^返工(?:\s|[：:]|$)/.test(text)
        ? 'revise'
        : undefined)
  if (decision) {
    if (channel.controlLevel === 'chat')
      return { kind: 'reject', silent: false, reason: '无裁决权限' }
    if (!message.binding) return { kind: 'reject', silent: false, reason: '请引用检查点卡片' }
    if (decision === 'revise' && !text.replace(/^返工[：:\s]*/, '').trim())
      return { kind: 'reject', silent: false, reason: '请引用检查点卡片回复“返工：具体意见”' }
    return {
      kind: 'decision',
      binding: message.binding,
      decision,
      note: `飞书 ${sender}：${text || '批准'}`,
    }
  }
  return text
    ? { kind: 'chat', conversationId, text }
    : { kind: 'reject', silent: false, reason: '消息内容为空' }
}
