import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { client, explainApiError, openSettings } from '../lib/store/index.ts'
import { CodeView } from './FileView.tsx'
import {
  IconCheck,
  IconChevron,
  IconFile,
  IconFolder,
  IconRefresh,
  IconSettings,
  IconTerminal,
  IconX,
} from './Icons.tsx'
import type { SshProfileRow } from './settings/SshSettings.tsx'

interface RemoteEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
}

interface LiveSession {
  sessionId: string
  home: string
  message: string
  target: { host: string; username?: string; port: number }
}

interface RemotePreviewResult {
  path: string
  kind: 'text' | 'markdown' | 'office' | 'image' | 'pdf' | 'audio' | 'video' | 'binary'
  mime: string
  size: number
  content?: string
  language?: string
  dataUri?: string
  truncated: boolean
  note?: string
}

export default function RemoteSshBrowser() {
  const [profiles, { refetch: refetchProfiles }] = createResource(() =>
    client.api<{ profiles: SshProfileRow[] }>('/api/ssh/profiles'),
  )
  const [command, setCommand] = createSignal('ssh ')
  const [authMode, setAuthMode] = createSignal<'system-key' | 'private-key' | 'password'>(
    'system-key',
  )
  const [password, setPassword] = createSignal('')
  const [privateKey, setPrivateKey] = createSignal('')
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = createSignal('')
  const [privateKeyFile, setPrivateKeyFile] = createSignal('')
  const [privateKeyError, setPrivateKeyError] = createSignal('')
  const [acceptNewHost, setAcceptNewHost] = createSignal(true)
  const [session, setSession] = createSignal<LiveSession | null>(null)
  const [path, setPath] = createSignal('')
  const [selected, setSelected] = createSignal<RemoteEntry | null>(null)
  const [connecting, setConnecting] = createSignal(false)
  const [opening, setOpening] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; bad?: boolean } | null>(null)
  const [openedWorkspace, setOpenedWorkspace] = createSignal<SshProfileRow | null>(null)

  const connect = async (sshCommand = command(), startPath?: string) => {
    setConnecting(true)
    setNotice({ text: '正在建立 SSH 连接…' })
    try {
      const result = await client.api<LiveSession>('/api/ssh/connect', {
        method: 'POST',
        body: JSON.stringify({
          command: sshCommand,
          acceptNewHost: acceptNewHost(),
          authMode: authMode(),
          ...(authMode() === 'password'
            ? { password: password() }
            : authMode() === 'private-key'
              ? {
                  privateKey: privateKey(),
                  privateKeyPassphrase: privateKeyPassphrase(),
                }
              : {}),
        }),
      })
      setPassword('')
      setPrivateKey('')
      setPrivateKeyPassphrase('')
      setPrivateKeyFile('')
      setPrivateKeyError('')
      setAuthMode('system-key')
      setCommand(sshCommand)
      setSession(result)
      setPath(startPath || result.home)
      setSelected(null)
      setOpenedWorkspace(null)
      setNotice({ text: result.message })
    } catch (error) {
      const text = explainApiError(error, 'SSH 连接失败')
      setNotice({ text, bad: true })
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = () => {
    setSession(null)
    setPath('')
    setSelected(null)
    setOpenedWorkspace(null)
    setNotice(null)
  }

  const listingKey = () => {
    const active = session()
    return active && path() ? { session: active.sessionId, path: path() } : null
  }
  const [listing, { refetch: refetchListing }] = createResource(listingKey, (current) =>
    client.api<{ path: string; entries: RemoteEntry[] }>(
      `/api/ssh/session/list?session=${encodeURIComponent(current.session)}&path=${encodeURIComponent(current.path)}`,
    ),
  )
  const previewKey = () => {
    const active = session()
    const file = selected()
    return active && file?.kind === 'file' ? { session: active.sessionId, path: file.path } : null
  }
  const [preview] = createResource(previewKey, (file) =>
    client.api<RemotePreviewResult>(
      `/api/ssh/session/preview?session=${encodeURIComponent(file.session)}&path=${encodeURIComponent(file.path)}`,
    ),
  )

  const openFolder = async () => {
    const active = session()
    if (!active) return
    setOpening(true)
    setNotice({ text: `正在打开 ${path()}…` })
    try {
      const result = await client.api<{ profile: SshProfileRow }>('/api/ssh/workspace', {
        method: 'POST',
        body: JSON.stringify({ sessionId: active.sessionId, path: path() }),
      })
      setOpenedWorkspace(result.profile)
      setNotice({ text: `已打开只读远程工作区 ${result.profile.root}` })
      await refetchProfiles()
    } catch (error) {
      setNotice({ text: explainApiError(error, '无法打开远程工作区'), bad: true })
    } finally {
      setOpening(false)
    }
  }

  const go = (entry: RemoteEntry) => {
    if (entry.kind === 'dir') {
      setPath(entry.path)
      setSelected(null)
    } else setSelected(entry)
  }

  const up = () => {
    const parent =
      path()
        .replace(/\/$/, '')
        .replace(/\/[^/]+$/, '') || '/'
    setPath(parent)
    setSelected(null)
  }

  return (
    <div class="remote-browser remote-ssh-workbench">
      <header class="workspace-view-head remote-workbench-head">
        <div>
          <span class="eyebrow">REMOTE SSH</span>
          <h2>远程资源管理器</h2>
          <p>使用系统 SSH 命令连接；只读浏览和内存预览，不提供文件传输。</p>
        </div>
        <Show when={session()}>
          <button class="btn-ghost" type="button" onClick={disconnect}>
            <IconX size={13} /> 断开连接
          </button>
        </Show>
      </header>

      <Show
        when={session()}
        fallback={
          <ConnectionStart
            profiles={profiles()?.profiles ?? []}
            command={command()}
            setCommand={setCommand}
            authMode={authMode()}
            setAuthMode={setAuthMode}
            password={password()}
            setPassword={setPassword}
            privateKey={privateKey()}
            setPrivateKey={setPrivateKey}
            privateKeyPassphrase={privateKeyPassphrase()}
            setPrivateKeyPassphrase={setPrivateKeyPassphrase}
            privateKeyFile={privateKeyFile()}
            setPrivateKeyFile={setPrivateKeyFile}
            privateKeyError={privateKeyError()}
            setPrivateKeyError={setPrivateKeyError}
            acceptNewHost={acceptNewHost()}
            setAcceptNewHost={setAcceptNewHost}
            connecting={connecting()}
            connect={connect}
            openSettings={() => openSettings('ssh')}
            notice={notice()}
          />
        }
      >
        {(active) => (
          <>
            <div class="remote-connection-bar">
              <span class="remote-connected-dot" />
              <strong>
                {active().target.username ? `${active().target.username}@` : ''}
                {active().target.host}
              </strong>
              <span>端口 {active().target.port}</span>
              <span class="remote-readonly">只读</span>
              <span class="spacer" />
              <Show when={openedWorkspace()}>
                {(workspace) => (
                  <span class="remote-opened">
                    <IconCheck size={12} /> Agent 工作区：{workspace().root}
                  </span>
                )}
              </Show>
            </div>

            <div class="remote-explorer">
              <aside class="remote-explorer-sidebar">
                <div class="remote-explorer-title">
                  <span>资源管理器</span>
                  <button
                    class="icon-btn"
                    type="button"
                    aria-label="刷新目录"
                    onClick={() => void refetchListing()}
                  >
                    <IconRefresh size={13} />
                  </button>
                </div>
                <div class="remote-breadcrumb">
                  <button
                    type="button"
                    onClick={() => {
                      setPath('/')
                      setSelected(null)
                    }}
                  >
                    /
                  </button>
                  <For each={path().split('/').filter(Boolean)}>
                    {(part, index) => (
                      <>
                        <IconChevron size={9} dir="right" />
                        <button
                          type="button"
                          onClick={() => {
                            setPath(
                              `/${path()
                                .split('/')
                                .filter(Boolean)
                                .slice(0, index() + 1)
                                .join('/')}`,
                            )
                            setSelected(null)
                          }}
                        >
                          {part}
                        </button>
                      </>
                    )}
                  </For>
                </div>
                <Show
                  when={!listing.error}
                  fallback={
                    <div class="pane-error">
                      {explainApiError(listing.error, '无法读取远程目录')}
                    </div>
                  }
                >
                  <div class="remote-tree">
                    <button
                      class="remote-row remote-parent"
                      type="button"
                      disabled={path() === '/'}
                      onClick={up}
                    >
                      <IconFolder size={15} />
                      <span>..</span>
                    </button>
                    <For each={listing()?.entries ?? []}>
                      {(entry) => (
                        <button
                          class="remote-row"
                          classList={{ active: selected()?.path === entry.path }}
                          type="button"
                          onClick={() => go(entry)}
                        >
                          {entry.kind === 'dir' ? <IconFolder size={15} /> : <IconFile size={15} />}
                          <span class="truncate">{entry.name}</span>
                          <Show when={entry.kind === 'file'}>
                            <span class="remote-size">{bytes(entry.size)}</span>
                          </Show>
                        </button>
                      )}
                    </For>
                    <Show when={!listing.loading && (listing()?.entries.length ?? 0) === 0}>
                      <div class="remote-empty">这个目录为空</div>
                    </Show>
                  </div>
                </Show>
                <div class="remote-open-folder">
                  <button
                    class="btn-primary"
                    type="button"
                    disabled={opening() || listing.loading}
                    onClick={() => void openFolder()}
                  >
                    <IconFolder size={13} /> {opening() ? '正在打开…' : '打开此文件夹作为工作区'}
                  </button>
                </div>
              </aside>

              <main class="remote-preview">
                <Show
                  when={selected()}
                  fallback={
                    <div class="remote-preview-empty">
                      <IconFile size={28} />
                      <strong>选择文件进行只读预览</strong>
                      <span>支持 PDF、Markdown、Office、代码与常见图片</span>
                    </div>
                  }
                >
                  {(file) => (
                    <>
                      <div class="remote-preview-head">
                        <code class="truncate">{file().path}</code>
                        <span>{bytes(file().size)}</span>
                      </div>
                      <RemotePreview
                        file={file()}
                        result={preview()}
                        loading={preview.loading}
                        error={preview.error}
                      />
                    </>
                  )}
                </Show>
              </main>
            </div>
            <Show when={notice()}>
              {(message) => (
                <p class="remote-notice" classList={{ bad: message().bad }}>
                  {message().text}
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function ConnectionStart(props: {
  profiles: SshProfileRow[]
  command: string
  setCommand(value: string): void
  authMode: 'system-key' | 'private-key' | 'password'
  setAuthMode(value: 'system-key' | 'private-key' | 'password'): void
  password: string
  setPassword(value: string): void
  privateKey: string
  setPrivateKey(value: string): void
  privateKeyPassphrase: string
  setPrivateKeyPassphrase(value: string): void
  privateKeyFile: string
  setPrivateKeyFile(value: string): void
  privateKeyError: string
  setPrivateKeyError(value: string): void
  acceptNewHost: boolean
  setAcceptNewHost(value: boolean): void
  connecting: boolean
  connect(command?: string, startPath?: string): Promise<void>
  openSettings(): void
  notice: { text: string; bad?: boolean } | null
}) {
  const savedCommand = (profile: SshProfileRow) =>
    `ssh ${profile.username ? `${profile.username}@` : ''}${profile.host}${profile.port === 22 ? '' : ` -p ${profile.port}`}`
  return (
    <div class="remote-connect-start">
      <div class="remote-command-card">
        <div class="remote-command-title">
          <IconTerminal size={17} />
          <div>
            <strong>连接到主机</strong>
            <span>高级选项请写入系统 ~/.ssh/config</span>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void props.connect()
          }}
        >
          <div class="remote-command-input">
            <span>&gt;</span>
            <input
              aria-label="SSH 命令"
              spellcheck={false}
              value={props.command}
              placeholder="ssh researcher@gpu-lab -p 22"
              onInput={(event) => props.setCommand(event.currentTarget.value)}
            />
            <button
              class="btn-primary"
              type="submit"
              disabled={
                props.connecting ||
                !props.command.trim() ||
                (props.authMode === 'password' && !props.password) ||
                (props.authMode === 'private-key' && !props.privateKey)
              }
            >
              {props.connecting ? '连接中…' : '连接'}
            </button>
          </div>
        </form>
        <div class="remote-auth-row">
          <fieldset class="remote-auth-switch">
            <legend>SSH 认证方式</legend>
            <button
              type="button"
              classList={{ active: props.authMode === 'system-key' }}
              onClick={() => props.setAuthMode('system-key')}
            >
              系统密钥
            </button>
            <button
              type="button"
              classList={{ active: props.authMode === 'private-key' }}
              onClick={() => props.setAuthMode('private-key')}
            >
              私钥文件 / 粘贴
            </button>
            <button
              type="button"
              classList={{ active: props.authMode === 'password' }}
              onClick={() => props.setAuthMode('password')}
            >
              密码认证
            </button>
          </fieldset>
          <Show when={props.authMode === 'password'}>
            <label class="remote-password-field">
              <span>密码</span>
              <input
                type="password"
                autocomplete="current-password"
                value={props.password}
                placeholder="仅本次运行使用，不保存"
                onInput={(event) => props.setPassword(event.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={props.authMode === 'private-key'}>
            <div class="remote-private-key">
              <div class="remote-key-file-row">
                <label class="btn-ghost sm remote-key-picker">
                  选择私钥文件
                  <input
                    type="file"
                    accept=".pem,.key,.openssh,application/x-pem-file,text/plain"
                    onChange={(event) => void readPrivateKeyFile(event.currentTarget, props)}
                  />
                </label>
                <span>{props.privateKeyFile || '未选择文件，也可以在下方粘贴'}</span>
              </div>
              <textarea
                aria-label="SSH 私钥内容"
                spellcheck={false}
                value={props.privateKey}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                onInput={(event) => {
                  props.setPrivateKey(event.currentTarget.value)
                  props.setPrivateKeyFile('')
                  props.setPrivateKeyError('')
                }}
              />
              <label class="remote-password-field">
                <span>私钥口令</span>
                <input
                  type="password"
                  autocomplete="off"
                  value={props.privateKeyPassphrase}
                  placeholder="没有口令可留空"
                  onInput={(event) => props.setPrivateKeyPassphrase(event.currentTarget.value)}
                />
              </label>
              <Show when={props.privateKeyError}>
                <span class="remote-key-error">{props.privateKeyError}</span>
              </Show>
            </div>
          </Show>
          <span class="remote-auth-note">
            {props.authMode === 'system-key'
              ? '使用系统 ssh-agent、默认私钥和 ~/.ssh/config。'
              : '凭证仅保存在当前应用进程内，关闭应用后清除；连接时的临时私钥文件用完即删。'}
          </span>
        </div>
        <label class="remote-host-policy">
          <input
            type="checkbox"
            checked={props.acceptNewHost}
            onChange={(event) => props.setAcceptNewHost(event.currentTarget.checked)}
          />
          首次连接自动记录主机密钥；密钥变化仍会拒绝
        </label>
        <Show when={props.notice}>
          {(message) => (
            <p class="remote-notice" classList={{ bad: message().bad }}>
              {message().text}
            </p>
          )}
        </Show>
      </div>

      <Show when={props.profiles.length > 0}>
        <section class="remote-recent">
          <div class="remote-section-head">
            <strong>最近的远程工作区</strong>
            <button class="btn-ghost sm" type="button" onClick={props.openSettings}>
              <IconSettings size={12} /> 管理
            </button>
          </div>
          <For each={props.profiles}>
            {(profile) => (
              <button
                class="remote-recent-row"
                type="button"
                onClick={() => void props.connect(savedCommand(profile), profile.root)}
              >
                <IconTerminal size={14} />
                <span>
                  <strong>{profile.name}</strong>
                  <code>{savedCommand(profile)}</code>
                </span>
                <em>{profile.root}</em>
                <IconChevron size={11} dir="right" />
              </button>
            )}
          </For>
        </section>
      </Show>
    </div>
  )
}

async function readPrivateKeyFile(
  input: HTMLInputElement,
  state: {
    setPrivateKey(value: string): void
    setPrivateKeyFile(value: string): void
    setPrivateKeyError(value: string): void
  },
): Promise<void> {
  const file = input.files?.[0]
  if (!file) return
  state.setPrivateKey('')
  state.setPrivateKeyFile(file.name)
  state.setPrivateKeyError('')
  if (file.size > 1024 * 1024) {
    state.setPrivateKeyError('私钥文件超过 1 MB，请检查是否选错文件。')
    input.value = ''
    return
  }
  try {
    const content = await file.text()
    if (/^PuTTY-User-Key-File-/i.test(content.trim())) {
      state.setPrivateKeyError('暂不支持 PuTTY PPK，请先导出为 OpenSSH 私钥。')
    } else if (!/-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----/.test(content)) {
      state.setPrivateKeyError('文件不是 OpenSSH 或 PEM 私钥。')
    } else {
      state.setPrivateKey(content)
    }
  } catch {
    state.setPrivateKeyError('无法读取所选私钥文件。')
  } finally {
    input.value = ''
  }
}

function RemotePreview(props: {
  file: RemoteEntry
  result: RemotePreviewResult | undefined
  loading: boolean
  error: unknown
}) {
  return (
    <Show
      when={!props.error}
      fallback={<div class="pane-error">{explainApiError(props.error, '无法预览远程文件')}</div>}
    >
      <Show
        when={props.result}
        fallback={<div class="preview-loading">{props.loading ? '正在读取…' : ''}</div>}
      >
        {(result) => (
          <Switch
            fallback={<div class="remote-preview-empty">{result().note ?? '无法预览此文件'}</div>}
          >
            <Match when={result().kind === 'markdown'}>
              <article
                class="remote-markdown markdown"
                innerHTML={renderMarkdown(result().content ?? '')}
              />
            </Match>
            <Match when={result().kind === 'text' || result().kind === 'office'}>
              <CodeView content={result().content ?? ''} path={result().path} />
            </Match>
            <Match when={result().kind === 'image'}>
              <img class="preview-media" src={result().dataUri} alt={result().path} />
            </Match>
            <Match when={result().kind === 'pdf'}>
              <iframe class="preview-frame" src={result().dataUri} title={result().path} />
            </Match>
            <Match when={result().kind === 'video'}>
              <video class="preview-media" src={result().dataUri} controls />
            </Match>
            <Match when={result().kind === 'audio'}>
              <audio class="preview-audio" src={result().dataUri} controls />
            </Match>
          </Switch>
        )}
      </Show>
    </Show>
  )
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
