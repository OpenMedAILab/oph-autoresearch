import { createResource, createSignal, For, onMount, Show } from 'solid-js'
import {
  cliDiscovery,
  cliDiscoveryError,
  client,
  closeSettings,
  discoverCliModels,
  explainApiError,
  setCenterView,
} from '../../lib/store/index.ts'
import { IconFolder, IconRefresh, IconTerminal, IconTrash } from '../Icons.tsx'
import { EmptyBox, Section } from './Page.tsx'

export interface SshProfileRow {
  id: string
  name: string
  host: string
  username?: string
  port: number
  root: string
  readOnly: boolean
  hostKeyPolicy: 'strict' | 'accept-new'
}

interface Payload {
  path: string
  profiles: SshProfileRow[]
}

export function SshSettings() {
  onMount(() => void discoverCliModels())
  const [data, { refetch }] = createResource(() => client.api<Payload>('/api/ssh/profiles'))
  const [busy, setBusy] = createSignal('')
  const [message, setMessage] = createSignal<{ text: string; bad?: boolean } | null>(null)

  const openRemote = () => {
    closeSettings()
    setCenterView('ssh')
  }

  const test = async (id: string) => {
    setBusy(id)
    setMessage({ text: '正在连接…' })
    try {
      const result = await client.api<{ ok: boolean; message: string }>('/api/ssh/test', {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      setMessage({ text: result.message, bad: !result.ok })
    } catch (error) {
      setMessage({ text: explainApiError(error, 'SSH 连接失败'), bad: true })
    } finally {
      setBusy('')
    }
  }

  const remove = async (id: string) => {
    const profiles = (data()?.profiles ?? []).filter((profile) => profile.id !== id)
    setBusy(id)
    try {
      await client.api('/api/ssh/profiles', {
        method: 'PUT',
        body: JSON.stringify({ profiles }),
      })
      await refetch()
      setMessage({ text: '已移除远程工作区；服务器文件没有变化' })
    } catch (error) {
      setMessage({ text: explainApiError(error, '移除失败'), bad: true })
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <Section
        title="远程工作区"
        desc="连接和选目录在远程资源管理器中完成"
        path={data()?.path ?? ''}
        actions={
          <button class="btn-primary sm" type="button" onClick={openRemote}>
            <IconTerminal size={13} /> 打开 Remote SSH
          </button>
        }
      >
        <Show
          when={(data()?.profiles.length ?? 0) > 0}
          fallback={
            <EmptyBox
              label="还没有远程工作区"
              actions={
                <button class="btn-ghost sm" type="button" onClick={openRemote}>
                  用 SSH 命令连接
                </button>
              }
            />
          }
        >
          <div class="ssh-workspace-list">
            <For each={data()?.profiles ?? []}>
              {(profile) => (
                <div class="ssh-workspace-row">
                  <IconFolder size={16} />
                  <div class="ssh-workspace-main">
                    <strong>{profile.name}</strong>
                    <code>
                      ssh {profile.username ? `${profile.username}@` : ''}
                      {profile.host}
                      {profile.port === 22 ? '' : ` -p ${profile.port}`}
                    </code>
                  </div>
                  <code class="ssh-workspace-path">{profile.root}</code>
                  <span class="entry-tag">{profile.readOnly ? '只读' : '实验读写'}</span>
                  <button
                    class="btn-ghost sm"
                    type="button"
                    disabled={busy() !== ''}
                    onClick={() => void test(profile.id)}
                  >
                    <IconRefresh size={12} /> {busy() === profile.id ? '连接中…' : '测试'}
                  </button>
                  <button
                    class="icon-btn"
                    type="button"
                    aria-label={`移除 ${profile.name}`}
                    disabled={busy() !== ''}
                    onClick={() => void remove(profile.id)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={message()}>
          {(result) => (
            <p class="config-status" classList={{ error: result().bad }}>
              {result().text}
            </p>
          )}
        </Show>
      </Section>
      <Section title="远程 CLI 执行端" desc="由本机主控模型协调实验，启动及 SSH 连接变更时自动探测">
        <Show when={cliDiscovery().probing}>
          <p class="remote-history-empty">正在后台探测服务器…</p>
        </Show>
        <Show when={cliDiscoveryError()}>
          <p class="pane-error">{cliDiscoveryError()}</p>
        </Show>
        <For each={cliDiscovery().hosts}>
          {(host) => (
            <div class="ssh-cli-host">
              <strong>{host.label}</strong>
              <p class="remote-history-empty">
                {host.status === 'probing' ? '探测中…' : host.message}
              </p>
              <For each={cliDiscovery().agents.filter((a) => a.profileId === host.id)}>
                {(cli) => (
                  <div class="cli-model-row">
                    <div class="cli-model-title">
                      <IconTerminal size={14} />
                      <strong>{cli.id} CLI</strong>
                      <span>
                        {cli.probe?.status === 'authenticated'
                          ? '已登录'
                          : cli.probe?.status === 'unauthenticated'
                            ? '未登录'
                            : '状态未确认'}
                      </span>
                    </div>
                    <code class="cli-model-path">{cli.path}</code>
                    <p class="remote-history-empty">{cli.probe?.message}</p>
                    <Show when={cli.probe?.models.length}>
                      <div class="ssh-cli-models">
                        <For each={cli.probe?.models}>
                          {(model) => <span class="entry-tag">{model.label}</span>}
                        </For>
                      </div>
                    </Show>
                    <p class="remote-history-empty">
                      {cli.canRun
                        ? '实验执行端 · 由本机主控模型指挥'
                        : '只读连接 · 执行实验前需启用实验模式'}
                    </p>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
        <Show when={!cliDiscovery().hosts.length && !cliDiscovery().probing}>
          <EmptyBox label="连接 SSH 服务器后自动发现远程 CLI" />
        </Show>
      </Section>
    </>
  )
}
