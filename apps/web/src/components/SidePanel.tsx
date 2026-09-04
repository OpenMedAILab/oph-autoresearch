import { Match, Show, Switch } from 'solid-js'
import { closePanel, openPanel, panelWidth, resizePanel, sidePanel } from '../lib/store/index.ts'
import { IconActivity, IconFile, IconX } from './Icons.tsx'
import { WorkflowOverview } from './ResearchWorkspace.tsx'
import { WorkspaceFileTree } from './WorkspaceFileTree.tsx'

/**
 * 右侧是工作区的持久索引：文件与研究流程。
 *
 * 两者都只负责定位内容：点击文件在中央编辑/预览，点击阶段在中央看详情。
 * SSH 仍从顶栏进入中央工作区；变更和子 Agent 不再占右栏一级入口。
 */
export default function SidePanel() {
  const view = () => (sidePanel() === 'workflow' ? 'workflow' : 'files')

  return (
    <Show when={sidePanel()}>
      <aside
        class="side-panel"
        classList={{ 'workflow-panel': view() === 'workflow', 'files-panel': view() === 'files' }}
        aria-label="工作区侧面板"
      >
        <button
          class="panel-grip"
          type="button"
          aria-label="拖动改变侧面板宽度"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              resizePanel(window.innerWidth - event.clientX)
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            resizePanel(panelWidth() + (event.key === 'ArrowLeft' ? 24 : -24))
          }}
        />

        <header class="side-head">
          <div class="side-tabs" role="tablist" aria-label="工作区资源">
            <button
              class="side-tab"
              classList={{ active: view() === 'files' }}
              type="button"
              role="tab"
              aria-selected={view() === 'files'}
              aria-controls="workspace-files-panel"
              onClick={() => openPanel('files')}
            >
              <IconFile size={13} />
              文件
            </button>
            <button
              class="side-tab"
              classList={{ active: view() === 'workflow' }}
              type="button"
              role="tab"
              aria-selected={view() === 'workflow'}
              aria-controls="research-workflow-panel"
              onClick={() => openPanel('workflow')}
            >
              <IconActivity size={13} />
              流程
            </button>
          </div>
          <button
            class="icon-btn panel-close-btn"
            type="button"
            aria-label="关闭侧面板"
            onClick={closePanel}
          >
            <IconX size={14} />
          </button>
        </header>

        <Switch>
          <Match when={view() === 'files'}>
            <div id="workspace-files-panel" class="files-panel-body" role="tabpanel">
              <WorkspaceFileTree />
            </div>
          </Match>
          <Match when={view() === 'workflow'}>
            <div id="research-workflow-panel" class="workflow-panel-body" role="tabpanel">
              <WorkflowOverview />
            </div>
          </Match>
        </Switch>
      </aside>
    </Show>
  )
}
