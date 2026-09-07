import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { loaded } from '../lib/resource.ts'
import {
  client,
  explainApiError,
  invalidateWorkspaceFiles,
  openFile,
  openFileInPanel,
  setOpenFile,
  state,
  workspace,
} from '../lib/store/index.ts'
import { dropMoveIssue } from '../lib/workspace-file-dnd.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import FileTypeIcon from './FileTypeIcon.tsx'
import { IconChevron, IconFolder, IconMore, IconRefresh } from './Icons.tsx'

interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  children?: FileNode[]
}

const parentDir = (path: string) => path.split('/').slice(0, -1).join('/')

/**
 * 右侧工作区里的文件树。
 *
 * 行尾菜单与右键菜单提供同一组文件操作：功能不能只藏在右键里，否则触屏、键盘
 * 和第一次使用的人都找不到。文件内容仍在中央主区域打开。
 */
export function WorkspaceFileTree() {
  const [tree, { refetch }] = createResource(
    () => {
      const id = workspace()?.id
      return id ? `${id}:${state.fileVersion}` : (false as const)
    },
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=1'),
  )
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [children, setChildren] = createSignal<ReadonlyMap<string, FileNode[]>>(new Map())
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set())
  const [menuAt, setMenuAt] = createSignal<{ node: FileNode; x: number; y: number } | null>(null)
  const [doomed, setDoomed] = createSignal<FileNode | null>(null)
  const [moving, setMoving] = createSignal<FileNode | null>(null)
  const [renaming, setRenaming] = createSignal<FileNode | null>(null)
  const [dragging, setDragging] = createSignal<FileNode | null>(null)
  const [dropTarget, setDropTarget] = createSignal<string | null>(null)
  const [working, setWorking] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<{ kind: 'ok' | 'error'; text: string } | null>(null)
  let noticeTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    workspace()?.id
    setExpanded(new Set<string>())
    setChildren(new Map<string, FileNode[]>())
    setMenuAt(null)
  })

  onCleanup(() => {
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  const announce = (kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text })
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => setNotice(null), kind === 'ok' ? 2200 : 5000)
  }

  const refresh = () => {
    setExpanded(new Set<string>())
    setChildren(new Map<string, FileNode[]>())
    invalidateWorkspaceFiles()
    void refetch()
  }

  const clearDrag = () => {
    setDragging(null)
    setDropTarget(null)
  }

  const canDropInto = (destination: string): boolean => {
    const source = dragging()
    return source !== null && dropMoveIssue(source, destination) === null
  }

  const markDropTarget = (destination: string): boolean => {
    if (!canDropInto(destination)) {
      if (dropTarget() === destination) setDropTarget(null)
      return false
    }
    setDropTarget(destination)
    return true
  }

  const toggle = async (node: FileNode) => {
    if (node.kind !== 'dir') {
      openFileInPanel(node.path)
      return
    }

    if (expanded().has(node.path)) {
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(node.path)
        return next
      })
      return
    }

    setExpanded((current) => new Set(current).add(node.path))
    if (children().has(node.path)) return
    setLoading((current) => new Set(current).add(node.path))
    try {
      const result = await client.api<{ nodes: FileNode[] }>(
        `/api/files/tree?path=${encodeURIComponent(node.path)}&depth=1`,
      )
      setChildren((current) => new Map(current).set(node.path, result.nodes))
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(node.path)
        return next
      })
    }
  }

  const copy = async (node: FileNode) => {
    setWorking(node.path)
    try {
      const result = await client.api<{ node: FileNode }>('/api/files/copy', {
        method: 'POST',
        body: JSON.stringify({ path: node.path }),
      })
      refresh()
      announce('ok', `已复制为 ${result.node.path}`)
    } catch (error) {
      announce('error', detail(error, '复制失败'))
    } finally {
      setWorking(null)
    }
  }

  const move = async (node: FileNode, destination: string) => {
    setWorking(node.path)
    try {
      const result = await client.api<{ node: FileNode }>('/api/files/move', {
        method: 'POST',
        body: JSON.stringify({ path: node.path, destination }),
      })
      const opened = openFile()
      if (opened === node.path) openFileInPanel(result.node.path)
      else if (opened?.startsWith(`${node.path}/`)) {
        openFileInPanel(`${result.node.path}${opened.slice(node.path.length)}`)
      }
      setMoving(null)
      refresh()
      announce('ok', `已移动到 ${result.node.path}`)
    } catch (error) {
      announce('error', detail(error, '移动失败'))
      throw error
    } finally {
      setWorking(null)
    }
  }

  const dropMove = async (destination: string) => {
    const source = dragging()
    const issue = source ? dropMoveIssue(source, destination) : '没有正在拖动的文件'
    clearDrag()
    if (!source) return
    if (issue) {
      announce('error', issue)
      return
    }
    try {
      await move(source, destination)
    } catch {
      // `move` 已经把服务端给出的具体原因放进状态提示；这里仅避免拖放事件产生
      // 未处理的 Promise rejection。表单移动仍会把错误抛给弹窗内联展示。
    }
  }

  const rename = async (node: FileNode, name: string) => {
    setWorking(node.path)
    try {
      const result = await client.api<{ node: FileNode }>('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ path: node.path, name }),
      })
      const opened = openFile()
      if (opened === node.path) openFileInPanel(result.node.path)
      else if (opened?.startsWith(`${node.path}/`)) {
        openFileInPanel(`${result.node.path}${opened.slice(node.path.length)}`)
      }
      setRenaming(null)
      refresh()
      announce('ok', `已重命名为 ${result.node.name}`)
    } catch (error) {
      announce('error', detail(error, '重命名失败'))
      throw error
    } finally {
      setWorking(null)
    }
  }

  const remove = async (node: FileNode) => {
    setWorking(node.path)
    try {
      await client.api('/api/files/delete', {
        method: 'POST',
        body: JSON.stringify({ path: node.path }),
      })
      const opened = openFile()
      if (opened === node.path || opened?.startsWith(`${node.path}/`)) setOpenFile(null)
      setDoomed(null)
      refresh()
      announce('ok', `已删除 ${node.path}`)
    } catch (error) {
      announce('error', detail(error, '删除失败'))
    } finally {
      setWorking(null)
    }
  }

  return (
    <div class="workspace-file-tree">
      <div
        class="workspace-file-tree-head"
        role="toolbar"
        aria-label="文件树工具与根目录投放区"
        classList={{ 'drop-target': dragging() !== null && dropTarget() === '' }}
        onDragOver={(event) => {
          if (!markDropTarget('')) return
          event.preventDefault()
          const transfer = event.dataTransfer
          if (transfer) transfer.dropEffect = 'move'
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void dropMove('')
        }}
      >
        <span class="truncate">
          {dragging() ? '拖到这里移至根目录' : (workspace()?.name ?? '工作区')}
        </span>
        <button class="icon-btn" type="button" aria-label="刷新文件" onClick={refresh}>
          <IconRefresh size={12} />
        </button>
      </div>
      <div class="workspace-file-tree-body">
        <Show
          when={loaded(tree)}
          fallback={
            <div class="workspace-tree-note">
              {tree.error ? explainApiError(tree.error, '文件读取失败') : '正在读取…'}
            </div>
          }
        >
          {(result) => (
            <For each={result().nodes}>
              {(node) => (
                <WorkspaceTreeNode
                  node={node}
                  depth={0}
                  expanded={expanded}
                  children={children}
                  loading={loading}
                  working={working}
                  dragging={dragging}
                  dropTarget={dropTarget}
                  onToggle={toggle}
                  onMenu={(target, x, y) => setMenuAt({ node: target, x, y })}
                  onDragStart={(target) => {
                    setDragging(target)
                    setDropTarget(null)
                  }}
                  onDragEnd={clearDrag}
                  onMarkDropTarget={markDropTarget}
                  onClearDropTarget={() => setDropTarget(null)}
                  onDrop={(destination) => void dropMove(destination)}
                />
              )}
            </For>
          )}
        </Show>
      </div>

      <Show when={notice()}>
        {(message) => (
          <output
            class="workspace-file-notice"
            classList={{ error: message().kind === 'error' }}
            aria-live="polite"
          >
            {message().text}
          </output>
        )}
      </Show>

      <Show when={menuAt()}>
        {(at) => (
          <FileMenu
            node={at().node}
            x={at().x}
            y={at().y}
            onClose={() => setMenuAt(null)}
            onCopy={() => void copy(at().node)}
            onMove={() => setMoving(at().node)}
            onRename={() => setRenaming(at().node)}
            onDelete={() => setDoomed(at().node)}
          />
        )}
      </Show>

      <MoveDialog
        node={moving()}
        busy={working() !== null}
        onCancel={() => setMoving(null)}
        onMove={move}
      />

      <RenameDialog
        node={renaming()}
        busy={working() !== null}
        onCancel={() => setRenaming(null)}
        onRename={rename}
      />

      <ConfirmDialog
        open={doomed() !== null}
        title={doomed()?.kind === 'dir' ? '删除文件夹' : '删除文件'}
        message={
          doomed()?.kind === 'dir'
            ? `${doomed()?.path} 及其中内容会被永久删除。`
            : `${doomed()?.path} 会被永久删除。`
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const node = doomed()
          if (node) void remove(node)
        }}
        onCancel={() => setDoomed(null)}
      />
    </div>
  )
}

function WorkspaceTreeNode(props: {
  node: FileNode
  depth: number
  expanded: () => ReadonlySet<string>
  children: () => ReadonlyMap<string, FileNode[]>
  loading: () => ReadonlySet<string>
  working: () => string | null
  dragging: () => FileNode | null
  dropTarget: () => string | null
  onToggle: (node: FileNode) => Promise<void>
  onMenu: (node: FileNode, x: number, y: number) => void
  onDragStart: (node: FileNode) => void
  onDragEnd: () => void
  onMarkDropTarget: (destination: string) => boolean
  onClearDropTarget: () => void
  onDrop: (destination: string) => void
}) {
  const isOpen = () => props.expanded().has(props.node.path)
  const kids = () => props.children().get(props.node.path) ?? props.node.children ?? []

  return (
    <>
      <div
        class="workspace-tree-item"
        classList={{
          active: props.node.kind === 'file' && openFile() === props.node.path,
          dragging: props.dragging()?.path === props.node.path,
          'drop-target': props.node.kind === 'dir' && props.dropTarget() === props.node.path,
        }}
      >
        <button
          class="workspace-tree-row"
          type="button"
          draggable={props.working() !== props.node.path}
          style={{ 'padding-left': `${8 + props.depth * 14}px` }}
          aria-expanded={props.node.kind === 'dir' ? isOpen() : undefined}
          onDragStart={(event) => {
            const transfer = event.dataTransfer
            if (!transfer) return
            transfer.effectAllowed = 'move'
            transfer.setData('text/plain', props.node.path)
            props.onDragStart(props.node)
          }}
          onDragEnd={props.onDragEnd}
          onDragOver={(event) => {
            if (props.node.kind !== 'dir' || !props.onMarkDropTarget(props.node.path)) return
            event.preventDefault()
            event.stopPropagation()
            const transfer = event.dataTransfer
            if (transfer) transfer.dropEffect = 'move'
          }}
          onDragLeave={(event) => {
            if (
              props.node.kind === 'dir' &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              props.onClearDropTarget()
            }
          }}
          onDrop={(event) => {
            if (props.node.kind !== 'dir') return
            event.preventDefault()
            event.stopPropagation()
            props.onDrop(props.node.path)
          }}
          onClick={() => void props.onToggle(props.node)}
          onContextMenu={(event) => {
            event.preventDefault()
            props.onMenu(props.node, event.clientX, event.clientY)
          }}
        >
          <Show
            when={props.node.kind === 'dir'}
            fallback={
              <>
                <span class="workspace-tree-indent" />
                <FileTypeIcon name={props.node.name} />
              </>
            }
          >
            <IconChevron size={10} dir={isOpen() ? 'down' : 'right'} />
            <IconFolder size={13} />
          </Show>
          <span class="truncate">{props.node.name}</span>
          <Show when={props.loading().has(props.node.path) || props.working() === props.node.path}>
            <span class="workspace-tree-loading">…</span>
          </Show>
        </button>
        <button
          class="workspace-tree-menu-button"
          type="button"
          aria-label={`${props.node.name} 的文件操作`}
          aria-haspopup="menu"
          onContextMenu={(event) => {
            event.preventDefault()
            props.onMenu(props.node, event.clientX, event.clientY)
          }}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            props.onMenu(props.node, box.right, box.bottom)
          }}
        >
          <IconMore size={12} />
        </button>
      </div>
      <Show when={props.node.kind === 'dir' && isOpen()}>
        <For each={kids()}>
          {(child) => (
            <WorkspaceTreeNode
              node={child}
              depth={props.depth + 1}
              expanded={props.expanded}
              children={props.children}
              loading={props.loading}
              working={props.working}
              dragging={props.dragging}
              dropTarget={props.dropTarget}
              onToggle={props.onToggle}
              onMenu={props.onMenu}
              onDragStart={props.onDragStart}
              onDragEnd={props.onDragEnd}
              onMarkDropTarget={props.onMarkDropTarget}
              onClearDropTarget={props.onClearDropTarget}
              onDrop={props.onDrop}
            />
          )}
        </For>
      </Show>
    </>
  )
}

function FileMenu(props: {
  node: FileNode
  x: number
  y: number
  onClose: () => void
  onCopy: () => void
  onMove: () => void
  onRename: () => void
  onDelete: () => void
}) {
  let menu!: HTMLDivElement

  onMount(() => {
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(props.x - 4, window.innerWidth - box.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(props.y - 4, window.innerHeight - box.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button')?.focus()
  })

  createEffect(() => {
    const closeOutside = (event: Event) => {
      if (!(event.target as HTMLElement | null)?.closest('.tree-menu')) props.onClose()
    }
    const closeWithKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeWithKey)
    onCleanup(() => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeWithKey)
    })
  })

  const run = (action: () => void) => {
    action()
    props.onClose()
  }

  return (
    <div
      class="tree-menu workspace-tree-menu"
      role="menu"
      ref={menu}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <div class="workspace-tree-menu-label">{props.node.name}</div>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(props.onCopy)}
      >
        复制副本
      </button>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(props.onMove)}
      >
        移动到…
      </button>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(props.onRename)}
      >
        重命名…
      </button>
      <div class="tree-menu-sep" />
      <button
        class="tree-menu-item danger"
        type="button"
        role="menuitem"
        onClick={() => run(props.onDelete)}
      >
        删除
      </button>
    </div>
  )
}

function RenameDialog(props: {
  node: FileNode | null
  busy: boolean
  onCancel: () => void
  onRename: (node: FileNode, name: string) => Promise<void>
}) {
  const [name, setName] = createSignal('')
  const [error, setError] = createSignal('')
  let input!: HTMLInputElement

  createEffect(() => {
    if (!props.node) return
    setName(props.node.name)
    setError('')
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  })

  const submit = async () => {
    const node = props.node
    const next = name().trim()
    if (!node || !next || props.busy) return
    setError('')
    try {
      await props.onRename(node, next)
    } catch (cause) {
      setError(detail(cause, '重命名失败'))
    }
  }

  return (
    <Show when={props.node}>
      {(node) => (
        <>
          <button
            class="backdrop-close"
            type="button"
            aria-label="取消重命名"
            onClick={props.onCancel}
          />
          <div class="sheet-backdrop pass-through">
            <form
              class="confirm-dialog file-move-dialog"
              aria-label="重命名文件"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <h2 class="confirm-title">重命名 {node().name}</h2>
              <label class="file-move-field">
                <span>新名称</span>
                <input
                  ref={input}
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <Show when={error()}>{(message) => <p class="file-move-error">{message()}</p>}</Show>
              <div class="confirm-actions">
                <button class="btn-ghost" type="button" onClick={props.onCancel}>
                  取消
                </button>
                <button class="btn-primary" type="submit" disabled={props.busy || !name().trim()}>
                  {props.busy ? '正在重命名…' : '重命名'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </Show>
  )
}

function MoveDialog(props: {
  node: FileNode | null
  busy: boolean
  onCancel: () => void
  onMove: (node: FileNode, destination: string) => Promise<void>
}) {
  const [destination, setDestination] = createSignal('.')
  const [error, setError] = createSignal('')
  let input!: HTMLInputElement

  createEffect(() => {
    if (!props.node) return
    setDestination(parentDir(props.node.path) || '.')
    setError('')
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  })

  const submit = async () => {
    const node = props.node
    const target = destination().trim()
    if (!node || !target || props.busy) return
    setError('')
    try {
      await props.onMove(node, target)
    } catch (cause) {
      setError(detail(cause, '移动失败'))
    }
  }

  return (
    <Show when={props.node}>
      {(node) => (
        <>
          <button
            class="backdrop-close"
            type="button"
            aria-label="取消移动"
            onClick={props.onCancel}
          />
          <div class="sheet-backdrop pass-through">
            <form
              class="confirm-dialog file-move-dialog"
              aria-label="移动文件"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <h2 class="confirm-title">移动 {node().name}</h2>
              <label class="file-move-field">
                <span>目标文件夹</span>
                <input
                  ref={input}
                  value={destination()}
                  placeholder="例如 archive/2026"
                  onInput={(event) => setDestination(event.currentTarget.value)}
                />
              </label>
              <p class="file-move-help">填写相对于当前工作区的文件夹路径，使用 “.” 表示根目录。</p>
              <Show when={error()}>{(message) => <p class="file-move-error">{message()}</p>}</Show>
              <div class="confirm-actions">
                <button class="btn-ghost" type="button" onClick={props.onCancel}>
                  取消
                </button>
                <button
                  class="btn-primary"
                  type="submit"
                  disabled={props.busy || !destination().trim()}
                >
                  {props.busy ? '正在移动…' : '移动'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </Show>
  )
}

function detail(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.detail
  return error instanceof Error ? error.message : fallback
}
