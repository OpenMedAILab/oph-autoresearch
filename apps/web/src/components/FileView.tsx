import type { EditorView } from '@codemirror/view'
import {
  createEffect,
  createResource,
  createSignal,
  lazy,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from 'solid-js'
import { filterXSS, getDefaultWhiteList } from 'xss'
import {
  createCodeEditor,
  type EditorPosition,
  languageName,
  showEditorSearch,
} from '../lib/editor.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import { loaded } from '../lib/resource.ts'
import {
  absPath,
  client,
  explainApiError,
  invalidateWorkspaceFiles,
  setCenterView,
  setOpenFile,
} from '../lib/store/index.ts'
import { IconCheck, IconCopy, IconSave, IconSearch, IconX } from './Icons.tsx'

// 懒加载：pdf.js 及其 worker 只跟着 PDF 预览走，不进文件视图的常驻块。
const PdfPreview = lazy(() => import('./PdfPreview.tsx').then((m) => ({ default: m.PdfPreview })))

interface PreviewResult {
  path: string
  kind:
    | 'text'
    | 'markdown'
    | 'html'
    | 'office'
    | 'image'
    | 'pdf'
    | 'audio'
    | 'video'
    | 'tabular'
    | 'archive'
    | 'binary'
  mime: string
  size: number
  mtime: number
  content?: string
  language?: string
  dataUri?: string
  truncated: boolean
  note?: string
}

/**
 * 打开的文件长在**主内容区**，不在右侧面板里。
 *
 * 面板那一列只有 `--panel-w` 宽，代码每行都要折；而看文件时文件树必须还在，
 * 否则「看下一个」得先返回。所以树留在面板、内容占主区——两块同时看得见。
 *
 * 输入区仍可随时唤出：面板放大时默认收在底部，悬浮或聚焦才展开，避免长期遮住
 * 正在看的文件；有草稿时保持展开。
 *
 * 默认导出给 `lazy()` 用：`CodeView` 拖着 CodeMirror 核心约 300 kB，
 * 只想聊天的用户不该为它付首屏成本。
 */
export default function FileView(props: { path: string; refresh?: number }) {
  const [docMode, setDocMode] = createSignal<'preview' | 'source'>('preview')
  const [copyState, setCopyState] = createSignal<'idle' | 'done'>('idle')
  const [draft, setDraft] = createSignal('')
  const [baseline, setBaseline] = createSignal('')
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveState, setSaveState] = createSignal<'idle' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = createSignal('')
  let activeEditor: EditorView | null = null
  let copyReceipt: ReturnType<typeof setTimeout> | undefined
  let saveReceipt: ReturnType<typeof setTimeout> | undefined
  let snapshotKey = ''
  let expectedMtime = 0
  // 路径与文件页的统一失效序号直接走资源判据。失效序号不在 `run.started` 清空，
  // 因此发起新一轮不会把“摘要从非空变空”误判成一次磁盘改动。
  const [result] = createResource(
    () => `${props.path}:${props.refresh ?? 0}`,
    () => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(props.path)}`),
  )

  createEffect(() => {
    props.path
    setDocMode('preview')
    setCopyState('idle')
    setDraft('')
    setBaseline('')
    setDirty(false)
  })

  createEffect(() => {
    const value = current()
    if (!value || value.content === undefined) return
    const key = `${value.path}:${value.mtime}`
    if (key === snapshotKey) return
    snapshotKey = key
    expectedMtime = value.mtime
    setDraft(value.content)
    setBaseline(value.content)
    setDirty(false)
    setSaveState('idle')
    setSaveError('')
  })

  onCleanup(() => {
    if (copyReceipt) clearTimeout(copyReceipt)
    if (saveReceipt) clearTimeout(saveReceipt)
  })

  const current = () => loaded(result)
  const sourceVisible = () => {
    const value = current()
    return (
      value?.kind === 'text' ||
      value?.kind === 'tabular' ||
      value?.kind === 'html' ||
      (value?.kind === 'markdown' && docMode() === 'source')
    )
  }
  const toggleable = () => {
    const kind = current()?.kind
    return kind === 'markdown' || kind === 'html'
  }
  const fileName = () => props.path.split('/').pop() ?? props.path
  const directory = () => {
    const full = absPath(props.path)
    const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
    return cut > 0 ? full.slice(0, cut) : full
  }

  const copySource = async () => {
    const content = draft()
    await navigator.clipboard?.writeText(content)
    setCopyState('done')
    if (copyReceipt) clearTimeout(copyReceipt)
    copyReceipt = setTimeout(() => setCopyState('idle'), 1200)
  }

  const editable = () => sourceVisible() && !current()?.truncated

  const saveSource = async () => {
    if (!editable() || saving() || !dirty()) return
    setSaving(true)
    setSaveState('idle')
    setSaveError('')
    try {
      const content = activeEditor?.state.doc.toString() ?? draft()
      const { node } = await client.api<{ node: { mtime: number } }>('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({ path: props.path, content, expectedMtime }),
      })
      expectedMtime = node.mtime
      setDraft(content)
      setBaseline(content)
      setDirty(false)
      setSaveState('saved')
      invalidateWorkspaceFiles()
      if (saveReceipt) clearTimeout(saveReceipt)
      saveReceipt = setTimeout(() => setSaveState('idle'), 1500)
    } catch (error) {
      setSaveState('error')
      setSaveError(explainApiError(error, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const close = () => {
    setOpenFile(null)
    setCenterView('chat')
  }

  return (
    <div class="preview">
      <header class="preview-head">
        <div class="preview-tab" title={absPath(props.path)}>
          <span class="file-language-mark" data-language={languageName(props.path)}>
            {fileMark(props.path)}
          </span>
          <span class="truncate">{fileName()}</span>
          <button class="preview-tab-close" type="button" aria-label="关闭文件" onClick={close}>
            <IconX size={12} />
          </button>
        </div>
        <span class="spacer" />
        <div class="preview-actions">
          <Show when={sourceVisible()}>
            <button
              class="icon-btn"
              classList={{ active: dirty() }}
              type="button"
              aria-label={saving() ? '正在保存文件' : dirty() ? '保存文件' : '文件已保存'}
              data-tip={saving() ? '正在保存…' : dirty() ? '保存（Ctrl+S）' : '文件已保存'}
              disabled={!editable() || saving() || !dirty()}
              onClick={() => void saveSource()}
            >
              <Show when={saveState() === 'saved'} fallback={<IconSave size={14} />}>
                <IconCheck size={14} />
              </Show>
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="在文件中查找"
              data-tip="查找（Ctrl+F）"
              onClick={() => showEditorSearch(activeEditor)}
            >
              <IconSearch size={14} />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="复制文件内容"
              data-tip={copyState() === 'done' ? '已复制' : '复制文件内容'}
              onClick={() => void copySource()}
            >
              <Show when={copyState() === 'done'} fallback={<IconCopy size={14} />}>
                <IconCheck size={14} />
              </Show>
            </button>
          </Show>
          <Show when={toggleable()}>
            <fieldset class="preview-mode-switch">
              <legend>{current()?.kind === 'html' ? 'HTML 查看方式' : 'Markdown 查看方式'}</legend>
              <button
                type="button"
                classList={{ active: docMode() === 'preview' }}
                onClick={() => setDocMode('preview')}
              >
                预览
              </button>
              <button
                type="button"
                classList={{ active: docMode() === 'source' }}
                onClick={() => setDocMode('source')}
              >
                源码
              </button>
            </fieldset>
          </Show>
        </div>
      </header>

      <div class="preview-breadcrumb" title={absPath(props.path)}>
        <span class="truncate-left" dir="rtl">
          <span dir="ltr">{directory()}</span>
        </span>
        <span class="preview-breadcrumb-separator">›</span>
        <strong>{fileName()}</strong>
        <Show when={sourceVisible()}>
          <span
            class="preview-edit-state"
            classList={{ dirty: dirty(), error: saveState() === 'error' }}
          >
            {saveState() === 'error'
              ? saveError()
              : saving()
                ? '正在保存'
                : dirty()
                  ? '已修改'
                  : editable()
                    ? '可编辑'
                    : '只读'}
          </span>
        </Show>
      </div>

      <div class="preview-body">
        {/* 取不回来要给一句话。`loaded()` 而不是 `result()`：后者出错时是 `throw`，
            而这一层外面只有给 `lazy()` 用的 Suspense，接不住抛出来的错——
            表现是这块地方永远停在加载态。 */}
        <Show
          when={loaded(result)}
          fallback={
            <Show when={result.error} fallback={<div class="preview-loading" />}>
              {(e) => <div class="preview-note">{explainApiError(e(), '打不开这个文件')}</div>}
            </Show>
          }
        >
          {(r) => (
            <Switch fallback={<div class="preview-note">{r().note ?? '无法预览'}</div>}>
              <Match when={r().kind === 'text' || r().kind === 'tabular'}>
                <CodeView
                  content={draft()}
                  path={r().path}
                  editable={editable()}
                  onChange={(content) => {
                    setDraft(content)
                    setDirty(content !== baseline())
                    setSaveState('idle')
                  }}
                  onSave={() => void saveSource()}
                  onReady={(next) => {
                    activeEditor = next
                  }}
                />
              </Match>
              <Match when={r().kind === 'markdown' || r().kind === 'html'}>
                <Show
                  when={docMode() === 'preview'}
                  fallback={
                    <CodeView
                      content={draft()}
                      path={r().path}
                      editable={editable()}
                      onChange={(content) => {
                        setDraft(content)
                        setDirty(content !== baseline())
                        setSaveState('idle')
                      }}
                      onSave={() => void saveSource()}
                      onReady={(next) => {
                        activeEditor = next
                      }}
                    />
                  }
                >
                  {r().kind === 'markdown' ? (
                    <article class="file-markdown markdown" innerHTML={renderMarkdown(draft())} />
                  ) : (
                    /*
                     * HTML 预览放进无脚本的沙箱 iframe：页面样式与脚本都不许碰到应用，
                     * 链接和表单在沙箱里也点不出去。sandbox 空值 = 全部能力关闭。
                     */
                    <iframe
                      class="preview-frame html-preview-frame"
                      sandbox=""
                      srcdoc={draft()}
                      title={r().path}
                    />
                  )}
                </Show>
              </Match>
              <Match when={r().kind === 'office'}>
                <article class="office-preview" innerHTML={sanitizeOfficeHtml(r().content ?? '')} />
              </Match>
              <Match when={r().kind === 'image'}>
                <img class="preview-media" src={r().dataUri} alt={r().path} />
              </Match>
              <Match when={r().kind === 'pdf'}>
                <Suspense fallback={<div class="preview-loading" />}>
                  <PdfPreview dataUri={r().dataUri ?? ''} title={r().path} />
                </Suspense>
              </Match>
              <Match when={r().kind === 'video'}>
                <video class="preview-media" src={r().dataUri} controls />
              </Match>
              <Match when={r().kind === 'audio'}>
                <audio class="preview-audio" src={r().dataUri} controls />
              </Match>
            </Switch>
          )}
        </Show>
      </div>

      <Show when={loaded(result)?.truncated}>
        <footer class="preview-foot">内容已截断</footer>
      </Show>
    </div>
  )
}

function fileMark(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  const ext = name.split('.').pop() ?? ''
  if (ext === 'ts' || ext === 'tsx') return 'TS'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'JS'
  if (ext === 'json') return '{}'
  if (ext === 'md' || ext === 'mdx') return 'M↓'
  if (ext === 'py') return 'PY'
  if (ext === 'rs') return 'RS'
  if (ext === 'html' || ext === 'htm') return '<>'
  if (ext === 'css' || ext === 'scss') return '#'
  return ext.slice(0, 2).toUpperCase() || '·'
}

const OFFICE_WHITELIST = {
  ...getDefaultWhiteList(),
  article: ['class'],
  section: ['class'],
  div: ['class'],
  span: ['class'],
  table: ['class'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
}

export function sanitizeOfficeHtml(html: string): string {
  return filterXSS(html, { whiteList: OFFICE_WHITELIST })
}

export function CodeView(props: {
  content: string
  path: string
  editable?: boolean
  onChange?: (content: string) => void
  onSave?: () => void
  onReady?: (view: EditorView | null) => void
}) {
  let host!: HTMLDivElement
  let view: EditorView | null = null
  let mountedPath: string | null = null
  let mountedEditable: boolean | null = null
  let syncing = false
  const [position, setPosition] = createSignal<EditorPosition>({ line: 1, column: 1 })
  /** 只有最后一次装配算数：语言包是动态 import，两次改动挨得近时后发的可能先到。 */
  let generation = 0

  // 只有路径变了才整块重建（语言包跟路径走）。同一个文件的正文更新直接派发到
  // 现有 CodeMirror：重建实例会把 `.cm-scroller` 换掉，用户读到中间时就回到顶部。
  //
  // 装在 `createEffect` 里，不装在 `ref` 回调里：ref 只在建元素那一下跑一次，
  // 而外层的 `Show` 不是 keyed，内容变了这个组件实例是留着的。
  createEffect(() => {
    const content = props.content
    const path = props.path
    const mine = ++generation

    if (view && mountedPath === path && mountedEditable === Boolean(props.editable)) {
      if (view.state.doc.toString() === content) return
      const { scrollLeft, scrollTop } = view.scrollDOM
      syncing = true
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      syncing = false
      // 全文替换会重算文档高度；恢复像素位置，内容变短时浏览器自然夹到新的底部。
      view.scrollDOM.scrollLeft = scrollLeft
      view.scrollDOM.scrollTop = scrollTop
      return
    }

    void (async () => {
      const next = await createCodeEditor(host, content, path, {
        editable: props.editable,
        onPosition: setPosition,
        onChange: (value) => {
          if (!syncing) props.onChange?.(value)
        },
        onSave: props.onSave,
      })
      if (mine !== generation) {
        next.destroy()
        return
      }
      view?.destroy()
      view = next
      mountedPath = path
      mountedEditable = Boolean(props.editable)
      props.onReady?.(next)
    })()
  })

  onCleanup(() => {
    props.onReady?.(null)
    view?.destroy()
  })

  const lineCount = () => Math.max(1, props.content.split(/\r\n?|\n/).length)
  const eol = () => (props.content.includes('\r\n') ? 'CRLF' : 'LF')

  return (
    <div class="code-editor-shell">
      <div class="code-view" ref={host} />
      <footer class="code-statusbar">
        <span>
          行 {position().line}，列 {position().column}
        </span>
        <span>{lineCount()} 行</span>
        <span class="spacer" />
        <span>UTF-8</span>
        <span>{eol()}</span>
        <span>{languageName(props.path)}</span>
      </footer>
    </div>
  )
}
