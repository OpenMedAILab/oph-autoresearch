import { createResource, createSignal, For, Show } from 'solid-js'
import { client, openSettings } from '../lib/store/index.ts'

type Choice = { profileId: string; remoteRoot: string }
type Profile = { id: string; root: string; readOnly: boolean }
export function ProjectServerDirectory(props: {
  onChange: (value: Choice | null) => void
  onConfigure: () => void
}) {
  const [profiles, { refetch }] = createResource(
    async () => (await client.api<{ profiles: Profile[] }>('/api/ssh/profiles')).profiles,
  )
  const [profileId, setProfileId] = createSignal('')
  const [path, setPath] = createSignal('')
  const [entries, setEntries] = createSignal<Array<{ name: string; path: string }>>([])
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  let generation = 0
  const update = () =>
    props.onChange(
      profileId() && path().startsWith('/') ? { profileId: profileId(), remoteRoot: path() } : null,
    )
  async function browse() {
    const current = ++generation,
      id = profileId(),
      requested = path()
    setLoading(true)
    setError('')
    setEntries([])
    try {
      const data = await client.api<{
        entries: Array<{ name: string; path: string; kind: string }>
      }>(`/api/ssh/list?profile=${encodeURIComponent(id)}&path=${encodeURIComponent(requested)}`)
      if (generation === current) setEntries(data.entries.filter((entry) => entry.kind === 'dir'))
    } catch (err) {
      if (generation === current)
        setError(err instanceof Error ? err.message : '无法读取服务器目录')
    } finally {
      if (generation === current) setLoading(false)
    }
  }
  return (
    <section class="np-field" aria-label="服务器工作目录">
      <label class="np-field">
        <span class="np-label">服务器（必选）</span>
        <select
          class="np-input"
          value={profileId()}
          onChange={(event) => {
            ++generation
            setLoading(false)
            setEntries([])
            setError('')
            const id = event.currentTarget.value
            setProfileId(id)
            setPath(
              profiles.error ? '' : (profiles()?.find((profile) => profile.id === id)?.root ?? ''),
            )
            update()
          }}
        >
          <option value="">选择已保存的服务器目录</option>
          <For each={profiles.error ? [] : (profiles() ?? [])}>
            {(profile, index) => (
              <option value={profile.id} disabled={profile.readOnly}>
                服务器 {index() + 1} · {profile.root}
                {profile.readOnly ? '（只读，需先改为可写）' : ''}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={profiles.error}>
        <p role="alert">服务器列表读取失败，请重试。</p>
      </Show>
      <div class="confirm-actions">
        <button
          type="button"
          class="btn-ghost"
          onClick={() => {
            props.onConfigure()
            openSettings('ssh')
          }}
        >
          配置服务器
        </button>
        <button type="button" class="btn-ghost" onClick={() => void refetch()}>
          刷新服务器列表
        </button>
      </div>
      <label class="np-field">
        <span class="np-label">服务器工作目录（必填）</span>
        <input
          class="np-input"
          placeholder="/path/to/research-project"
          value={path()}
          disabled={!profileId()}
          onInput={(event) => {
            ++generation
            setLoading(false)
            setEntries([])
            setPath(event.currentTarget.value)
            update()
          }}
        />
      </label>
      <button
        type="button"
        class="btn-ghost"
        disabled={!profileId() || !path().startsWith('/') || loading()}
        onClick={() => void browse()}
      >
        {loading() ? '读取目录中…' : '浏览服务器目录'}
      </button>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <ul class="np-directory-list">
        <For each={entries()}>
          {(entry) => (
            <li>
              <button
                type="button"
                class="btn-ghost"
                onClick={() => {
                  setPath(entry.path)
                  setEntries([])
                  update()
                }}
              >
                {entry.name}
              </button>
            </li>
          )}
        </For>
      </ul>
      <p class="np-hint">
        本机目录保存研究对话、方案和产物索引；服务器目录用于代码与实验。创建前会验证服务器目录存在且可写，绑定不会自动同步或搬移数据。
      </p>
    </section>
  )
}
