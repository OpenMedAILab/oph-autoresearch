import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { client, explainApiError, openSettings } from '../lib/store/index.ts'
import { CodeView } from './FileView.tsx'
import {
  IconCheck,
  IconChevron,
  IconClock,
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

interface SshRecentConnectionRow {
  host: string
  username?: string
  port: number
  authMode: 'system-key' | 'private-key' | 'password'
  hostKeyPolicy: 'strict' | 'accept-new'
  home: string
  lastPath?: string
  lastConnectedAt: number
}

interface SshProfilesPayload {
  profiles: SshProfileRow[]
  recentConnections: SshRecentConnectionRow[]
}

interface SshTargetDraft {
  host: string
  username?: string
  port: number | string
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
    client.api<SshProfilesPayload>('/api/ssh/profiles'),
  )
  const [username, setUsername] = createSignal('')
  const [host, setHost] = createSignal('')
  const [port, setPort] = createSignal('22')
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
  const [pathDraft, setPathDraft] = createSignal('')
  const [selected, setSelected] = createSignal<RemoteEntry | null>(null)
  const [connecting, setConnecting] = createSignal(false)
  const [opening, setOpening] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; bad?: boolean } | null>(null)
  const [openedWorkspace, setOpenedWorkspace] = createSignal<SshProfileRow | null>(null)

  const connect = async (
    target: SshTargetDraft = { username: username(), host: host(), port: port() },
    startPath?: string,
  ) => {
    setConnecting(true)
    setNotice({ text: '正在建立 SSH 连接…' })
    try {
      const result = await client.api<LiveSession>('/api/ssh/connect', {
        method: 'POST',
        body: JSON.stringify({
          username: target.username?.trim() || undefined,
          host: target.host.trim(),
          port: Number(target.port),
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
      setUsername(result.target.username ?? '')
      setHost(result.target.host)
      setPort(String(result.target.port))
      setSession(result)
      const initialPath = startPath || result.home
      setPath(initialPath)
      setPathDraft(initialPath)
      setSelected(null)
      setOpenedWorkspace(null)
      setNotice({ text: result.message })
      await refetchProfiles()
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
    setPathDraft('')
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
      setPathDraft(entry.path)
      setSelected(null)
    } else setSelected(entry)
  }

  const up = () => {
    const parent =
      path()
        .replace(/\/$/, '')
        .replace(/\/[^/]+$/, '') || '/'
    setPath(parent)
    setPathDraft(parent)
    setSelected(null)
  }

  const navigateToDraft = () => {
    const next = pathDraft().trim()
    if (!next) {
      setNotice({ text: '请输入远程数据目录，例如 /data/oph', bad: true })
      return
    }
    setPath(next)
    setSelected(null)
    setNotice(null)
  }

  const useRecent = (recent: SshRecentConnectionRow) => {
    setUsername(recent.username ?? '')
    setHost(recent.host)
    setPort(String(recent.port))
    setAcceptNewHost(recent.hostKeyPolicy === 'accept-new')
    setAuthMode(recent.authMode)
    const startPath = recent.lastPath || recent.home
    if (recent.authMode === 'system-key') {
      void connect(recent, startPath)
      return
    }
    setNotice({
      text:
        recent.authMode === 'password'
          ? '已载入连接记录。为保护凭证，请重新输入密码后连接。'
          : '已载入连接记录。为保护凭证，请重新选择或粘贴私钥后连接。',
    })
  }

  return (
    <div class="remote-browser remote-ssh-workbench">
      <header class="workspace-view-head remote-workbench-head">
        <div>
          <span class="eyebrow">REMOTE SSH</span>
          <h2>远程数据工作区</h2>
          <p>连接服务器，选择数据目录，再将该目录开放给科研 Agent。</p>
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
            recentConnections={profiles()?.recentConnections ?? []}
            username={username()}
            setUsername={setUsername}
            host={host()}
            setHost={setHost}
            port={port()}
            setPort={setPort}
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
            useRecent={useRecent}
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

            <form
              class="remote-directory-bar"
              onSubmit={(event) => {
                event.preventDefault()
                navigateToDraft()
              }}
            >
              <span class="remote-step">2</span>
              <label for="remote-data-directory">选择数据目录</label>
              <div class="remote-directory-input">
                <IconFolder size={14} />
                <input
                  id="remote-data-directory"
                  aria-describedby="remote-directory-help"
                  spellcheck={false}
                  value={pathDraft()}
                  placeholder="/data/oph"
                  onInput={(event) => setPathDraft(event.currentTarget.value)}
                />
              </div>
              <button class="btn-ghost sm" type="submit" disabled={!pathDraft().trim()}>
                转到
              </button>
              <button
                class="btn-primary sm"
                type="button"
                disabled={opening() || listing.loading || Boolean(listing.error)}
                onClick={() => void openFolder()}
              >
                <IconFolder size={13} /> {opening() ? '正在设置…' : '设为 Agent 工作区'}
              </button>
              <span id="remote-directory-help">
                可直接输入路径，也可在下方逐级进入文件夹；当前目录为 {path()}。
              </span>
            </form>

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
                      setPathDraft('/')
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
                            setPathDraft(
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
              </aside>

              <main class="remote-preview">
                <Show
                  when={selected()}
                  fallback={
                    <div class="remote-preview-empty">
                      <IconFile size={28} />
                      <strong>
                        {openedWorkspace() ? '选择文件进行只读预览' : '先选择数据目录'}
                      </strong>
                      <span>
                        {openedWorkspace()
                          ? '支持 PDF、Markdown、Office、代码与常见图片'
                          : '在左侧进入目录后，点击上方“设为 Agent 工作区”'}
                      </span>
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
                <p
                  class="remote-notice remote-session-notice"
                  classList={{ bad: message().bad }}
                  role={message().bad ? 'alert' : 'status'}
                >
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
  recentConnections: SshRecentConnectionRow[]
  username: string
  setUsername(value: string): void
  host: string
  setHost(value: string): void
  port: string
  setPort(value: string): void
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
  connect(target?: SshTargetDraft, startPath?: string): Promise<void>
  useRecent(recent: SshRecentConnectionRow): void
  openSettings(): void
  notice: { text: string; bad?: boolean } | null
}) {
  return (
    <div class="remote-connect-start">
      <div class="remote-command-card">
        <div class="remote-command-title">
          <span class="remote-step">1</span>
          <div>
            <strong>连接到主机</strong>
            <span>填写连接信息，后端将安全组装 OpenSSH 参数</span>
          </div>
        </div>
        <form
          class="remote-target-form"
          onSubmit={(event) => {
            event.preventDefault()
            void props.connect()
          }}
        >
          <div class="remote-target-grid">
            <label class="remote-target-field" for="remote-ssh-username">
              <span>用户名</span>
              <input
                id="remote-ssh-username"
                aria-describedby={props.notice?.bad ? 'remote-connect-error' : undefined}
                autocomplete="username"
                spellcheck={false}
                value={props.username}
                placeholder="root"
                onInput={(event) => props.setUsername(event.currentTarget.value)}
              />
            </label>
            <label class="remote-target-field remote-target-host" for="remote-ssh-host">
              <span>主机地址</span>
              <input
                id="remote-ssh-host"
                aria-describedby={props.notice?.bad ? 'remote-connect-error' : undefined}
                autocomplete="url"
                spellcheck={false}
                value={props.host}
                placeholder="49.233.190.200"
                onInput={(event) => props.setHost(event.currentTarget.value)}
              />
            </label>
            <label class="remote-target-field remote-target-port" for="remote-ssh-port">
              <span>端口</span>
              <input
                id="remote-ssh-port"
                aria-describedby={props.notice?.bad ? 'remote-connect-error' : undefined}
                type="number"
                inputmode="numeric"
                min="1"
                max="65535"
                value={props.port}
                onInput={(event) => props.setPort(event.currentTarget.value)}
              />
            </label>
          </div>
          <div class="remote-target-actions">
            <div class="remote-command-preview" aria-live="polite">
              <span>将执行</span>
              <code>
                {commandFor({
                  ...(props.username.trim() ? { username: props.username.trim() } : {}),
                  host: props.host.trim() || '主机地址',
                  port: validPort(props.port) ? Number(props.port) : 22,
                })}
              </code>
            </div>
            <button
              class="btn-primary remote-connect-button"
              type="submit"
              disabled={
                props.connecting ||
                !props.host.trim() ||
                !validPort(props.port) ||
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
            <p
              id={message().bad ? 'remote-connect-error' : undefined}
              class="remote-notice"
              classList={{ bad: message().bad }}
              role={message().bad ? 'alert' : 'status'}
            >
              {message().text}
            </p>
          )}
        </Show>
      </div>

      <div class="remote-connection-library">
        <section class="remote-recent">
          <div class="remote-section-head">
            <span>
              <IconClock size={13} />
              <strong>最近连接</strong>
            </span>
            <button class="btn-ghost sm" type="button" onClick={props.openSettings}>
              <IconSettings size={12} /> 管理
            </button>
          </div>
          <Show
            when={props.recentConnections.length > 0}
            fallback={
              <p class="remote-history-empty">成功连接后会自动保存在这里，不保存密码和私钥。</p>
            }
          >
            <For each={props.recentConnections}>
              {(recent) => (
                <button
                  class="remote-recent-row"
                  type="button"
                  onClick={() => props.useRecent(recent)}
                >
                  <IconTerminal size={14} />
                  <span>
                    <strong>
                      {recent.username ? `${recent.username}@` : ''}
                      {recent.host}
                    </strong>
                    <code>{commandFor(recent)}</code>
                  </span>
                  <em>{recent.lastPath || recent.home}</em>
                  <span class="remote-history-action">
                    {authModeLabel(recent.authMode)}
                    <IconChevron size={11} dir="right" />
                  </span>
                </button>
              )}
            </For>
          </Show>
        </section>

        <Show when={props.profiles.length > 0}>
          <section class="remote-recent remote-saved-workspaces">
            <div class="remote-section-head">
              <span>
                <IconFolder size={13} />
                <strong>已保存数据目录</strong>
              </span>
            </div>
            <For each={props.profiles}>
              {(profile) => (
                <button
                  class="remote-recent-row"
                  type="button"
                  onClick={() => {
                    const recent = props.recentConnections.find(
                      (item) =>
                        item.host.toLowerCase() === profile.host.toLowerCase() &&
                        item.username === profile.username &&
                        item.port === profile.port,
                    )
                    if (recent) props.useRecent({ ...recent, lastPath: profile.root })
                    else void props.connect(profile, profile.root)
                  }}
                >
                  <IconFolder size={14} />
                  <span>
                    <strong>{profile.name}</strong>
                    <code>{commandFor(profile)}</code>
                  </span>
                  <em>{profile.root}</em>
                  <IconChevron size={11} dir="right" />
                </button>
              )}
            </For>
          </section>
        </Show>
      </div>
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

function commandFor(target: { host: string; username?: string; port: number }): string {
  return `ssh ${target.username ? `${target.username}@` : ''}${target.host} -p ${target.port}`
}

function validPort(value: string): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function authModeLabel(mode: SshRecentConnectionRow['authMode']): string {
  if (mode === 'password') return '需密码'
  if (mode === 'private-key') return '需私钥'
  return '快速连接'
}
