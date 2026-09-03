import { createResource, createSignal, For, Show } from 'solid-js'
import { client, closeSettings, explainApiError, setCenterView } from '../../lib/store/index.ts'
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
                <span class="entry-tag">只读</span>
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
  )
}
