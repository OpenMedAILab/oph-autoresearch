import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { client, pickWorkspace, type WorkspaceInput } from '../lib/store/index.ts'
import { IconFolder, IconPlus } from './Icons.tsx'

/** 创建研究项目；Web 端通过本地服务浏览文件夹，桌面端使用系统选择器。 */
export function NewProjectDialog(props: {
  open: boolean
  /** 桌面外壳才有系统目录选择器。 */
  canPickFolder: boolean
  onCreate: (input: WorkspaceInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = createSignal('')
  const [folder, setFolder] = createSignal<string | null>(null)
  const [browsing, setBrowsing] = createSignal(false)
  const [folderPath, setFolderPath] = createSignal('')
  const [directory, setDirectory] = createSignal<{
    path: string
    parent: string
    folders: { name: string; path: string }[]
  } | null>(null)
  const [loadingFolders, setLoadingFolders] = createSignal(false)
  const browse = async (path = '') => {
    setError(null)
    setLoadingFolders(true)
    setDirectory(null)
    try {
      const result = await client.api<{
        path: string
        parent: string
        folders: { name: string; path: string }[]
      }>(`/api/workspace-folders?path=${encodeURIComponent(path)}`)
      setDirectory(result)
      setFolderPath(result.path)
      setBrowsing(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFolders(false)
    }
  }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // 每次打开都是干净的一张表：留着上一次的输入读起来像是它记住了什么。
  createEffect(() => {
    if (props.open) {
      setBrowsing(false)
      setDirectory(null)
      setName('')
      setFolder(null)
      setError(null)
      setBusy(false)
    }
  })

  createEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  /** 选了文件夹而没填名字时，名字就是那个文件夹名——不逼用户填两遍。 */
  const effectiveName = () =>
    name().trim() || (folder() ? (folder() as string).split(/[/\\]/).pop() : '')

  const pick = async () => {
    if (!props.canPickFolder) {
      await browse()
      return
    }
    setError(null)
    try {
      const picked = await pickWorkspace()
      // 取消不是错误。
      if (picked) setFolder(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = async () => {
    setError(null)
    setBusy(true)
    try {
      await props.onCreate({
        ...(folder() ? { path: folder() as string } : {}),
        ...(name().trim() ? { name: name().trim() } : {}),
      })
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.open}>
      <button class="backdrop-close" type="button" aria-label="取消" onClick={props.onClose} />
      <div class="sheet-backdrop pass-through">
        <div class="new-project" role="dialog" aria-modal="true" aria-label="新建研究项目">
          <h2 class="confirm-title">新建研究项目</h2>

          <label class="np-field">
            <span class="np-label">项目名称</span>
            <input
              class="np-input"
              type="text"
              value={name()}
              placeholder={folder() ? '留空就用文件夹名' : '例如：视网膜病变分级研究'}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>

          <div class="np-field">
            <span class="np-label">源文件夹</span>
            <Show
              when={folder()}
              fallback={
                <div class="np-folder empty">
                  <button
                    class="np-pick"
                    type="button"
                    disabled={loadingFolders()}
                    onClick={() => void pick()}
                  >
                    <IconPlus size={14} />
                    选择本机项目文件夹
                  </button>
                  {/* 边界声明留全（B7）：不写的话「留空会发生什么」没有任何提示。 */}
                  <span class="np-hint">留空就在 oph-autoresearch 的数据目录下新建一个</span>
                </div>
              }
            >
              {(f) => (
                <div class="np-folder">
                  <IconFolder size={15} />
                  <span class="np-path">{f()}</span>
                  <button class="np-clear" type="button" onClick={() => setFolder(null)}>
                    改用新建
                  </button>
                </div>
              )}
            </Show>
          </div>

          <Show when={browsing()}>
            <section class="np-browser" aria-label="选择本机项目文件夹">
              <label class="np-field">
                <span class="np-label">文件夹路径</span>
                <input
                  class="np-input"
                  value={folderPath()}
                  onInput={(e) => setFolderPath(e.currentTarget.value)}
                />
              </label>
              <div class="confirm-actions">
                <button
                  class="btn-ghost"
                  type="button"
                  disabled={loadingFolders()}
                  onClick={() => void browse(folderPath())}
                >
                  打开路径
                </button>
                <button
                  class="btn-ghost"
                  type="button"
                  disabled={
                    loadingFolders() || !directory() || directory()?.parent === directory()?.path
                  }
                  onClick={() => void browse(directory()!.parent)}
                >
                  上一级
                </button>
              </div>
              <div class="np-directory-list">
                <For each={directory()?.folders}>
                  {(entry) => (
                    <button class="np-pick" type="button" onClick={() => void browse(entry.path)}>
                      <IconFolder size={15} />
                      {entry.name}
                    </button>
                  )}
                </For>
                <Show when={directory()?.folders.length === 0}>
                  <span class="np-hint">此文件夹没有子文件夹</span>
                </Show>
              </div>
              <button
                class="btn-primary"
                type="button"
                disabled={loadingFolders() || !directory()}
                onClick={() => {
                  setFolder(directory()!.path)
                  setBrowsing(false)
                }}
              >
                选择此文件夹
              </button>
            </section>
          </Show>

          {/* 失败要有终态：名字不合法、目录建不出来，都在这里说出来。 */}
          <Show when={error()}>{(e) => <p class="np-error">{e()}</p>}</Show>

          <div class="confirm-actions">
            <button class="btn-ghost" type="button" onClick={props.onClose}>
              取消
            </button>
            <button
              class="btn-primary"
              type="button"
              disabled={busy() || !effectiveName()}
              onClick={() => void create()}
            >
              {busy() ? '创建中…' : '创建项目'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
