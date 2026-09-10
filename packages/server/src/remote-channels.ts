/** 远程遥控通道的控制面配置。凭证只保存环境变量名，不把 secret 写入 JSON。 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { globalScopeRoot } from '@oph-autoresearch/tools'

export type RemoteChannelKind = 'feishu'
export type RemoteControlLevel = 'chat' | 'review' | 'control'

export interface RemoteChannelConfig {
  id: string
  kind: RemoteChannelKind
  name: string
  enabled: boolean
  appId: string
  secretEnv: string
  allowFrom: string[]
  controlLevel: RemoteControlLevel
  chatId?: string
  conversationId?: string
}

export const REMOTE_CHANNEL_CATALOG = [
  {
    kind: 'feishu',
    name: '飞书机器人',
    transport: 'WebSocket 长连接',
    credentialHint: 'App ID',
  },
] as const

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i
const ENV = /^[A-Z_][A-Z0-9_]{0,95}$/

export function remoteChannelsPath(): string {
  return join(globalScopeRoot(), 'remote-channels.json')
}

export function loadRemoteChannels(): RemoteChannelConfig[] {
  let parsed: { channels?: unknown }
  try {
    parsed = JSON.parse(readFileSync(remoteChannelsPath(), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed.channels)) return []
  return parsed.channels.map(normalize).filter((item): item is RemoteChannelConfig => item !== null)
}

export async function saveRemoteChannels(input: unknown): Promise<RemoteChannelConfig[]> {
  if (!Array.isArray(input)) throw new Error('channels 必须是数组')
  const channels = input.map((item, index) => {
    const channel = normalize(item)
    if (!channel) throw new Error(`第 ${index + 1} 条远程通道配置无效`)
    if (channel.enabled && channel.allowFrom.length === 0) {
      throw new Error(`${channel.name} 启用前必须填写允许操作者 ID`)
    }
    return channel
  })
  const ids = new Set<string>()
  const apps = new Set<string>()
  for (const channel of channels) {
    if (ids.has(channel.id)) throw new Error(`远程通道标识重复：${channel.id}`)
    if (channel.enabled && apps.has(channel.appId)) throw new Error('同一飞书应用只能启用一条通道')
    if (channel.enabled) apps.add(channel.appId)
    if (Boolean(channel.chatId) !== Boolean(channel.conversationId))
      throw new Error('群聊必须同时绑定主会话')
    ids.add(channel.id)
  }
  const path = remoteChannelsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ channels }, null, 2)}\n`, 'utf8')
  return channels
}

function normalize(input: unknown): RemoteChannelConfig | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const kind = value.kind
  if (!REMOTE_CHANNEL_CATALOG.some((item) => item.kind === kind)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const appId = typeof value.appId === 'string' ? value.appId.trim() : ''
  const secretEnv = typeof value.secretEnv === 'string' ? value.secretEnv.trim() : ''
  const controlLevel =
    value.controlLevel === 'review' || value.controlLevel === 'control'
      ? value.controlLevel
      : 'chat'
  const allowFrom = Array.isArray(value.allowFrom)
    ? [
        ...new Set(
          value.allowFrom
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : []
  if (!ID.test(id) || !appId || !ENV.test(secretEnv)) return null
  return {
    id,
    kind: kind as RemoteChannelKind,
    name: name || REMOTE_CHANNEL_CATALOG.find((item) => item.kind === kind)!.name,
    enabled: value.enabled === true,
    appId,
    secretEnv,
    allowFrom,
    controlLevel,
    ...(typeof value.chatId === 'string' && value.chatId.trim()
      ? { chatId: value.chatId.trim() }
      : {}),
    ...(typeof value.conversationId === 'string' && value.conversationId.trim()
      ? { conversationId: value.conversationId.trim() }
      : {}),
  }
}

type ConnectionState = 'connecting' | 'connected' | 'failed' | 'disabled'
const connectionStates = new Map<string, ConnectionState>()
export function setRemoteChannelConnectionState(id: string, state: ConnectionState): void {
  connectionStates.set(id, state)
}

export function remoteChannelStatus(channel: RemoteChannelConfig) {
  const credentialReady = Boolean(process.env[channel.secretEnv])
  return {
    id: channel.id,
    configured: Boolean(channel.appId && channel.secretEnv && channel.allowFrom.length),
    credentialReady,
    state: !channel.enabled
      ? 'disabled'
      : !credentialReady
        ? 'missing_credential'
        : (connectionStates.get(channel.id) ?? 'configured'),
  }
}
