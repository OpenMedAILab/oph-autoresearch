import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { client, explainApiError } from '../lib/store/index.ts'
import { IconChevron, IconPlus, IconTrash } from './Icons.tsx'

interface Candidate {
  name: string
  address: string
  url: string
  qr: string
}
interface PairingInfo {
  url: string
  token: string
  deviceName: string
  qr: string
  lanEnabled: boolean
  candidates: Candidate[]
}

type ChannelKind = 'dingtalk' | 'feishu' | 'wecom' | 'qq'
type ControlLevel = 'chat' | 'review' | 'control'
interface ChannelConfig {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  appId: string
  secretEnv: string
  allowFrom: string[]
  controlLevel: ControlLevel
}
interface ChannelCatalog {
  kind: ChannelKind
  name: string
  transport: string
  credentialHint: string
}
interface ChannelStatus {
  id: string
  configured: boolean
  credentialReady: boolean
  state: 'disabled' | 'missing_credential' | 'configured'
}
interface ChannelsPayload {
  path: string
  catalog: ChannelCatalog[]
  channels: ChannelConfig[]
  statuses: ChannelStatus[]
}

export default function PairPanel() {
  const [info, { refetch }] = createResource(() => client.api<PairingInfo>('/api/pairing'))
  const [channels, { refetch: refetchChannels }] = createResource(() =>
    client.api<ChannelsPayload>('/api/remote-channels'),
  )
  const [picked, setPicked] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [drafts, setDrafts] = createSignal<ChannelConfig[] | null>(null)
  const [expanded, setExpanded] = createSignal('')
  const [message, setMessage] = createSignal<{ text: string; bad?: boolean } | null>(null)
  const rows = () => drafts() ?? channels()?.channels ?? []

  const toggleLan = async (enabled: boolean) => {
    setBusy(true)
    try {
      await client.api('/api/pairing/lan', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  const add = (item: ChannelCatalog) => {
    const existing = rows().find((channel) => channel.kind === item.kind)
    if (existing) {
      setExpanded(existing.id)
      return
    }
    const next: ChannelConfig = {
      id: item.kind,
      kind: item.kind,
      name: item.name,
      enabled: false,
      appId: '',
      secretEnv: `OPH_${item.kind.toUpperCase()}_SECRET`,
      allowFrom: [],
      controlLevel: 'chat',
    }
    setDrafts([...rows(), next])
    setExpanded(next.id)
  }

  const change = (id: string, patch: Partial<ChannelConfig>) => {
    setDrafts(rows().map((row) => (row.id === id ? { ...row, ...patch } : row)))
    setMessage(null)
  }

  const save = async () => {
    setBusy(true)
    try {
      const result = await client.api<ChannelsPayload>('/api/remote-channels', {
        method: 'PUT',
        body: JSON.stringify({ channels: rows() }),
      })
      setDrafts(result.channels)
      setMessage({ text: '远程通道控制面配置已保存' })
      await refetchChannels()
    } catch (error) {
      setMessage({ text: explainApiError(error, '远程通道保存失败'), bad: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="remote-access-stack">
      <section class="remote-access-section">
        <div class="remote-access-heading">
          <div>
            <strong>浏览器遥控</strong>
            <span>手机或平板直接打开同一会话</span>
          </div>
          <Show when={loaded(info)}>
            {(data) => (
              <label class="pair-toggle">
                <input
                  type="checkbox"
                  checked={data().lanEnabled}
                  disabled={busy()}
                  onChange={(event) => void toggleLan(event.currentTarget.checked)}
                />
                <span>允许同一网络接入</span>
              </label>
            )}
          </Show>
        </div>
        <Show
          when={loaded(info)}
          fallback={
            <Show when={info.error} fallback={<div class="preview-loading" />}>
              {(error) => <p class="pair-hint">{explainApiError(error(), '读不到接入信息')}</p>}
            </Show>
          }
        >
          {(data) => (
            <Show
              when={data().lanEnabled}
              fallback={<p class="pair-hint">开启后显示一次性配对二维码</p>}
            >
              <div class="pair-inline">
                <Qr text={data().candidates[picked()]?.qr ?? data().qr} />
                <div class="pair-inline-meta">
                  <strong>扫码接入当前桌面服务</strong>
                  <p class="pair-hint">令牌随应用退出失效；审批与运行记录会同步回桌面。</p>
                  <Show when={data().candidates.length > 1}>
                    <div class="pair-addrs">
                      <For each={data().candidates}>
                        {(candidate, index) => (
                          <button
                            class="pair-addr"
                            classList={{ active: picked() === index() }}
                            type="button"
                            onClick={() => setPicked(index())}
                          >
                            <code>{candidate.address}</code>
                            <span class="truncate">{candidate.name}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          )}
        </Show>
      </section>

      <section class="remote-access-section">
        <div class="remote-access-heading">
          <div>
            <strong>聊天机器人遥控</strong>
            <span>统一进入同一条会话、权限和审计链</span>
          </div>
        </div>
        <div class="channel-catalog">
          <For each={channels()?.catalog ?? []}>
            {(item) => {
              const configured = () => rows().find((row) => row.kind === item.kind)
              const status = () => channels()?.statuses.find((row) => row.id === configured()?.id)
              return (
                <div class="channel-row" classList={{ expanded: expanded() === configured()?.id }}>
                  <button
                    class="channel-row-main"
                    type="button"
                    onClick={() =>
                      configured()
                        ? setExpanded(expanded() === configured()!.id ? '' : configured()!.id)
                        : add(item)
                    }
                  >
                    <span class="channel-status" data-state={status()?.state ?? 'disabled'} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.transport}</small>
                    </span>
                    <em>{configured() ? statusLabel(status()?.state) : '未配置'}</em>
                    {configured() ? (
                      <IconChevron
                        size={11}
                        dir={expanded() === configured()!.id ? 'down' : 'right'}
                      />
                    ) : (
                      <IconPlus size={12} />
                    )}
                  </button>
                  <Show when={expanded() === configured()?.id ? configured() : undefined}>
                    {(row) => (
                      <div class="channel-form">
                        <label>
                          <span>App / Bot ID</span>
                          <input
                            value={row().appId}
                            placeholder={item.credentialHint}
                            onInput={(event) =>
                              change(row().id, { appId: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label>
                          <span>密钥环境变量</span>
                          <input
                            value={row().secretEnv}
                            spellcheck={false}
                            onInput={(event) =>
                              change(row().id, {
                                secretEnv: event.currentTarget.value.toUpperCase(),
                              })
                            }
                          />
                        </label>
                        <label class="wide">
                          <span>允许操作者 ID（一行一个）</span>
                          <textarea
                            rows={3}
                            value={row().allowFrom.join('\n')}
                            onInput={(event) =>
                              change(row().id, {
                                allowFrom: event.currentTarget.value
                                  .split('\n')
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                        <label>
                          <span>遥控级别</span>
                          <select
                            value={row().controlLevel}
                            onChange={(event) =>
                              change(row().id, {
                                controlLevel: event.currentTarget.value as ControlLevel,
                              })
                            }
                          >
                            <option value="chat">仅发起对话</option>
                            <option value="review">对话 + 审批</option>
                            <option value="control">对话 + 审批 + 停止运行</option>
                          </select>
                        </label>
                        <label class="channel-enabled">
                          <input
                            type="checkbox"
                            checked={row().enabled}
                            onChange={(event) =>
                              change(row().id, { enabled: event.currentTarget.checked })
                            }
                          />
                          启用通道
                        </label>
                        <button
                          class="icon-btn channel-remove"
                          type="button"
                          aria-label={`移除 ${row().name}`}
                          onClick={() => {
                            setDrafts(rows().filter((item) => item.id !== row().id))
                            setExpanded('')
                          }}
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
        <p class="pair-hint">
          微信使用企业微信官方 AI
          Bot；不接入非官方个人微信协议。密钥只从环境变量读取，不写入配置文件。
        </p>
        <Show when={rows().length > 0}>
          <div class="remote-channel-actions">
            <button class="btn-primary" type="button" disabled={busy()} onClick={() => void save()}>
              {busy() ? '保存中…' : '保存通道配置'}
            </button>
            <Show when={message()}>
              {(result) => <span classList={{ bad: result().bad }}>{result().text}</span>}
            </Show>
          </div>
        </Show>
      </section>
    </div>
  )
}

function statusLabel(state?: ChannelStatus['state']): string {
  if (state === 'configured') return '凭证就绪'
  if (state === 'missing_credential') return '缺少环境变量'
  return '未启用'
}

function Qr(props: { text: string }) {
  const [svg] = createResource(
    () => props.text,
    async (text) => {
      const { default: QRCode } = await import('qrcode')
      return QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 150,
      }).catch(() => '')
    },
  )
  return (
    <div class="pair-qr">
      <Show when={svg()} fallback={<div class="preview-loading" />}>
        <div innerHTML={svg()!} />
      </Show>
    </div>
  )
}
