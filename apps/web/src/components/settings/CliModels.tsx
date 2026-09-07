import { createSignal, For, onMount, Show } from 'solid-js'
import {
  cliDiscovery,
  cliDiscoveryError,
  discoverCliModels,
  isRunning,
  setModel,
  state,
} from '../../lib/store/index.ts'
import { IconRefresh, IconTerminal } from '../Icons.tsx'

const labels = {
  authenticated: '已登录',
  unauthenticated: '未登录',
  unknown: '登录状态未确认',
  error: '探测失败',
}
export function CliModels() {
  const probing = () => cliDiscovery().probing
  const error = cliDiscoveryError
  const probe = () => discoverCliModels(true)
  onMount(() => void discoverCliModels())
  return (
    <section class="settings-block">
      <div class="remote-section-head">
        <strong>本机 CLI 主控模型</strong>
        <button class="btn-ghost sm" type="button" disabled={probing()} onClick={probe}>
          <IconRefresh size={13} />
          {probing() ? '正在探测…' : '探测登录与模型'}
        </button>
      </div>
      <p class="remote-history-empty">
        启动时自动查询本机 CLI 的登录状态和模型目录。远程实验执行端在 SSH 服务器中查看。
      </p>
      <Show when={error()}>
        <p class="pane-error">{error() || '无法检测 CLI，请重试。'}</p>
      </Show>
      <Show when={!probing() && cliDiscovery().agents.filter((a) => !a.profileId).length === 0}>
        <p class="remote-history-empty">
          未发现支持的 CLI。安装并在终端登录后，点击“探测登录与模型”。
        </p>
      </Show>
      <For each={cliDiscovery().agents.filter((a) => !a.profileId)}>
        {(cli) => {
          const [model, setDraft] = createSignal(cli.probe?.models[0]?.id ?? '')
          const selected = () =>
            state.conversations.some(
              (c) =>
                c.id === state.activeConversation &&
                c.provider === cli.provider &&
                c.model === model(),
            )
          return (
            <div class="cli-model-row">
              <div class="cli-model-title">
                <IconTerminal size={16} />
                <strong>
                  {cli.id} CLI · {cli.location}
                </strong>
                <span>{cli.probe ? labels[cli.probe.status] : '尚未探测'}</span>
              </div>
              <code class="cli-model-path">{cli.path}</code>
              <Show when={cli.probe}>
                {(p) => (
                  <p class="remote-history-empty">
                    {p().message} · {new Date(p().checkedAt).toLocaleTimeString()} 检查
                  </p>
                )}
              </Show>
              <Show when={!cli.canRun}>
                <p class="remote-history-empty">只读连接：保存为 SSH 实验工作区后可用于对话。</p>
              </Show>
              <Show when={cli.probe?.models.length}>
                <div class="cli-model-actions">
                  <select
                    class="np-input"
                    aria-label={`${cli.id} 可用模型 · ${cli.location}`}
                    value={model()}
                    onChange={(e) => setDraft(e.currentTarget.value)}
                  >
                    <For each={cli.probe?.models}>
                      {(m) => <option value={m.id}>{m.label}</option>}
                    </For>
                  </select>
                  <button
                    class="btn-primary sm"
                    type="button"
                    disabled={
                      !cli.canRun ||
                      !model() ||
                      !state.activeConversation ||
                      isRunning() ||
                      selected()
                    }
                    onClick={() => setModel(cli.provider, model())}
                  >
                    {selected() ? '当前对话已选择' : '用于当前对话'}
                  </button>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
      <p class="remote-history-empty">
        {!state.activeConversation
          ? '创建研究项目后，可在对话中选择 CLI 模型。'
          : 'CLI 使用自身的权限和账户计费；模型目录不代表额度充足，实际调用结果以 CLI 为准。'}
      </p>
    </section>
  )
}
