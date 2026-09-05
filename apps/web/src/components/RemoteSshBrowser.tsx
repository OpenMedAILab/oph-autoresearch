import {
  createEffect,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  Show,
  Suspense,
  Switch,
} from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { client, explainApiError, openSettings } from '../lib/store/index.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { CodeView, sanitizeOfficeHtml } from './FileView.tsx'
import {
  IconCheck,
  IconChevron,
  IconClock,
  IconFile,
  IconFolder,
  IconRefresh,
  IconSettings,
  IconTerminal,
  IconTrash,
  IconX,
} from './Icons.tsx'
import type { SshProfileRow } from './settings/SshSettings.tsx'

// 懒加载：pdf.js 及其 worker 只跟着远程 PDF 预览走。
const PdfPreview = lazy(() => import('./PdfPreview.tsx').then((m) => ({ default: m.PdfPreview })))

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
  /** 服务端按凭证段算出来的：这条最近连接有没有保存过密码/私钥。 */
  hasSavedCredential?: boolean
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
  kind: 'text' | 'markdown' | 'html' | 'office' | 'image' | 'pdf' | 'audio' | 'video' | 'binary'
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
  // 端口不预填：22 是 OpenSSH 默认值，但预填一个「默认端口」会让表单看起来
  // 已经填好了——命令预览里写着 -p 22，实际上用户并不打算连 22（本例是 12572）。
  // 端口必须显式填写才算数。
  const [port, setPort] = createSignal('')
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
  /** 待删除的远程条目；非空时弹确认框。 */
  const [deleteTarget, setDeleteTarget] = createSignal<RemoteEntry | null>(null)
  const [deleting, setDeleting] = createSignal(false)
  /** 待删除的最近连接（连带其凭证）；非空时弹确认框。 */
  const [recentDeleteTarget, setRecentDeleteTarget] = createSignal<SshRecentConnectionRow | null>(
    null,
  )
  const [recentDeleting, setRecentDeleting] = createSignal(false)
  /** 连接失败时自增一档，让认证字段拿回焦点等用户重输。 */
  const [credentialFocusTick, setCredentialFocusTick] = createSignal(0)

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
      // 连接没成，刚输过的凭证作废：清掉并让认证字段接住焦点等重输。
      setPassword('')
      setPrivateKey('')
      setPrivateKeyPassphrase('')
      setPrivateKeyFile('')
      setPrivateKeyError('')
      setCredentialFocusTick((n) => n + 1)
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

  /** 最近连接删除后：移除条目 + 清凭证，然后刷新列表。 */
  const forgetRecent = async () => {
    const target = recentDeleteTarget()
    if (!target) return
    setRecentDeleting(true)
    try {
      await client.api<{ ok: boolean }>('/api/ssh/recent/delete', {
        method: 'POST',
        body: JSON.stringify({
          host: target.host,
          ...(target.username ? { username: target.username } : {}),
          port: target.port,
        }),
      })
      setNotice({
        text: `已删除连接记录 ${target.username ? `${target.username}@` : ''}${target.host}`,
      })
      await refetchProfiles()
    } catch (error) {
      setNotice({ text: explainApiError(error, '删除失败'), bad: true })
    } finally {
      setRecentDeleting(false)
      setRecentDeleteTarget(null)
    }
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
    // 密码/私钥先试已保存的凭证：没保存过或认证失败时，服务端会回一句
    // 「请输入/请重输」，界面留在表单上等用户填。
    setNotice({ text: '正在使用已保存的凭证连接…' })
    void connect(recent, startPath)
  }

  const confirmDelete = async () => {
    const entry = deleteTarget()
    const active = session()
    if (!entry || !active || deleting()) return
    setDeleting(true)
    try {
      await client.api<{ ok: boolean }>('/api/ssh/session/delete', {
        method: 'POST',
        body: JSON.stringify({ sessionId: active.sessionId, path: entry.path }),
      })
      setNotice({ text: `已删除 ${entry.path}` })
      if (selected()?.path === entry.path) setSelected(null)
      setDeleteTarget(null)
      await refetchListing()
    } catch (error) {
      setNotice({ text: explainApiError(error, '删除失败'), bad: true })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
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
            recentDeleteTarget={recentDeleteTarget()}
            setRecentDeleteTarget={setRecentDeleteTarget}
            recentDeleting={recentDeleting()}
            forgetRecent={forgetRecent}
            openSettings={() => openSettings('ssh')}
            notice={notice()}
            credentialFocusTick={credentialFocusTick()}
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
                        <div
                          class="remote-row"
                          classList={{ active: selected()?.path === entry.path }}
                        >
                          <button class="remote-row-main" type="button" onClick={() => go(entry)}>
                            {entry.kind === 'dir' ? (
                              <IconFolder size={15} />
                            ) : (
                              <IconFile size={15} />
                            )}
                            <span class="truncate">{entry.name}</span>
                            <Show when={entry.kind === 'file'}>
                              <span class="remote-size">{bytes(entry.size)}</span>
                            </Show>
                          </button>
                          {/* 破坏性操作收在悬停才露面的按钮里，且必须过确认框——
                              远端删除不可恢复，不能和「点开看看」同一条路。 */}
                          <button
                            class="remote-row-del"
                            type="button"
                            aria-label={`删除 ${entry.name}`}
                            data-tip={`删除 ${entry.name}`}
                            onClick={() => setDeleteTarget(entry)}
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
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
            <ConfirmDialog
              open={deleteTarget() !== null}
              title="删除远程条目"
              message={`将永久删除 ${deleteTarget()?.name ?? ''}（${deleteTarget()?.path ?? ''}）。目录内的全部内容一并删除，无法恢复。`}
              confirmLabel={deleting() ? '删除中…' : '删除'}
              danger
              onConfirm={() => void confirmDelete()}
              onCancel={() => setDeleteTarget(null)}
            />
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
  recentDeleteTarget: SshRecentConnectionRow | null
  setRecentDeleteTarget(value: SshRecentConnectionRow | null): void
  recentDeleting: boolean
  forgetRecent(): Promise<void>
  openSettings(): void
  notice: { text: string; bad?: boolean } | null
  /** 连接失败时自增；认证字段跟着它把焦点接回来。 */
  credentialFocusTick: number
}) {
  let passwordInput!: HTMLInputElement
  let keyArea!: HTMLTextAreaElement

  // 失败后焦点落回认证字段：用户接下来要做的就是重输，别让他再点一下。
  createEffect(() => {
    props.credentialFocusTick
    queueMicrotask(() => {
      if (props.authMode === 'password') passwordInput?.focus()
      else if (props.authMode === 'private-key') keyArea?.focus()
    })
  })

  /** 当前填的主机有没有保存过凭证：决定提示语是「自动使用」还是「成功后保存」。 */
  const savedHere = () =>
    props.recentConnections.some(
      (recent) =>
        recent.host.toLowerCase() === props.host.trim().toLowerCase() &&
        recent.username === props.username.trim() &&
        recent.port === Number(props.port) &&
        recent.hasSavedCredential,
    )

  const authNote = () => {
    if (props.authMode === 'system-key') {
      return '使用系统 ssh-agent、默认私钥和 ~/.ssh/config。'
    }
    return savedHere()
      ? '已保存凭证，连接时将自动使用；认证失败会清除并要求重新输入。'
      : '连接成功后凭证会保存到本机，之后自动使用；认证失败会清除并要求重新输入。'
  }

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
                placeholder="必填"
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
                placeholder="例如 101.35.218.231"
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
                {commandForPreview({
                  ...(props.username.trim() ? { username: props.username.trim() } : {}),
                  host: props.host.trim() || '主机地址',
                  port: props.port,
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
                ref={passwordInput}
                type="password"
                autocomplete="current-password"
                value={props.password}
                placeholder="首次连接需输入，成功后会保存"
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
                ref={keyArea}
                aria-label="SSH 私钥内容"
                spellcheck={false}
                value={props.privateKey}
                placeholder="首次连接需粘贴，成功后会保存"
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
          <span class="remote-auth-note">{authNote()}</span>
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
              <p class="remote-history-empty">
                成功连接后会记录在这里；密码和私钥经确认后保存在本机配置，认证失败会自动清除。
              </p>
            }
          >
            <For each={props.recentConnections}>
              {(recent) => (
                <div class="remote-recent-row">
                  <button
                    class="remote-recent-main"
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
                      {recent.hasSavedCredential
                        ? recent.authMode === 'password'
                          ? '已记住密码'
                          : '已记住密钥'
                        : authModeLabel(recent.authMode)}
                      <IconChevron size={11} dir="right" />
                    </span>
                  </button>
                  {/* 删除是破坏性动作，但必须看得见入口：悬停才露面的按钮此前
                      被用户当成「没有删除」。点它只是确认，不会真删。 */}
                  <button
                    class="remote-recent-del"
                    type="button"
                    aria-label={`删除连接记录 ${recent.host}`}
                    data-tip="删除此连接记录"
                    onClick={() => props.setRecentDeleteTarget(recent)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
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

      <ConfirmDialog
        open={props.recentDeleteTarget !== null}
        title="删除连接记录"
        message={`将删除连接记录 ${props.recentDeleteTarget ? `${props.recentDeleteTarget.username ? `${props.recentDeleteTarget.username}@` : ''}${props.recentDeleteTarget.host}:${props.recentDeleteTarget.port}` : ''}。${
          props.recentDeleteTarget?.hasSavedCredential ? ' 已保存的密码或私钥也会一并清除。' : ''
        }`}
        confirmLabel={props.recentDeleting ? '删除中…' : '删除'}
        onConfirm={() => void props.forgetRecent()}
        onCancel={() => props.setRecentDeleteTarget(null)}
      />
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
            <Match when={result().kind === 'html'}>
              {/* 与本地 HTML 预览同口径：无脚本沙箱 iframe。 */}
              <iframe
                class="preview-frame html-preview-frame"
                sandbox=""
                srcdoc={result().content ?? ''}
                title={result().path}
              />
            </Match>
            <Match when={result().kind === 'text'}>
              <CodeView content={result().content ?? ''} path={result().path} />
            </Match>
            <Match when={result().kind === 'office'}>
              {/* 与本地文件预览同一套渲染（docx/xlsx/pptx → HTML），同一份白名单。 */}
              <article
                class="office-preview"
                innerHTML={sanitizeOfficeHtml(result().content ?? '')}
              />
            </Match>
            <Match when={result().kind === 'image'}>
              <img class="preview-media" src={result().dataUri} alt={result().path} />
            </Match>
            <Match when={result().kind === 'pdf'}>
              <Suspense fallback={<div class="preview-loading" />}>
                <PdfPreview dataUri={result().dataUri ?? ''} title={result().path} />
              </Suspense>
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
      <Show when={props.result?.truncated}>
        <footer class="preview-foot">内容已截断</footer>
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

/** 连接表单里的预览：端口还没填时不能假装是 22——按 OpenSSH 默认值显示会骗人。 */
function commandForPreview(target: { host: string; username?: string; port: string }): string {
  const port = validPort(target.port) ? String(Number(target.port)) : '端口'
  return `ssh ${target.username ? `${target.username}@` : ''}${target.host} -p ${port}`
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
