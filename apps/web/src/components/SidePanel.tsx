import { For, lazy, Match, Show, Suspense, Switch } from 'solid-js'
import {
  activePanelTab,
  closePanel,
  closePanelTab,
  openPanel,
  panelTabs,
  panelTabUrl,
  panelWidth,
  resizePanel,
  setSidePanel,
  sidePanel,
} from '../lib/store/index.ts'
import { IconActivity, IconFile, IconX } from './Icons.tsx'
import { WorkflowOverview } from './ResearchWorkspace.tsx'
import { WorkspaceFileTree } from './WorkspaceFileTree.tsx'

const ConversationPanel = lazy(() => import('./ConversationPanel.tsx'))
const CliPanel = lazy(() => import('./CliPanel.tsx'))
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx'))

/**
 * 右侧是工作区的持久索引：文件与研究流程。
 *
 * 两者都只负责定位内容：点击文件在中央编辑/预览，点击阶段在中央看详情。
 * SSH 仍从顶栏进入中央工作区。
 *
 * 固定两格之外，面板里还能再开页：子会话（`openConversationTab`）、外部 CLI 的输出
 * （`openCliTab`）、终端与浏览器页。它们不是面板的第一级入口，是点开某张卡片后
 * 翻出来的一页——**页签条里带上 ×，点 × 只是关页，不收起面板**（`closePanelTab`）。
 */
export default function SidePanel() {
  /** 'files' / 'workflow' 之外的 sidePanel 值都是某页的 id（`{tab: id}`）。 */
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
              classList={{ active: sidePanel() === 'files' }}
              type="button"
              role="tab"
              aria-selected={sidePanel() === 'files'}
              aria-controls="workspace-files-panel"
              onClick={() => openPanel('files')}
            >
              <IconFile size={13} />
              文件
            </button>
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'workflow' }}
              type="button"
              role="tab"
              aria-selected={sidePanel() === 'workflow'}
              aria-controls="research-workflow-panel"
              onClick={() => openPanel('workflow')}
            >
              <IconActivity size={13} />
              流程
            </button>
            <div class="side-tab-divider" />
            <For each={panelTabs()}>
              {(tab) => (
                <div class="side-tab closable" classList={{ active: activePanelTab() === tab.id }}>
                  <button
                    class="tab-name"
                    type="button"
                    role="tab"
                    aria-selected={activePanelTab() === tab.id}
                    onClick={() => setSidePanel({ tab: tab.id })}
                  >
                    <span class="truncate">{tab.title}</span>
                  </button>
                  <button
                    class="tab-close"
                    type="button"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={() => closePanelTab(tab.id)}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              )}
            </For>
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

        <div class="side-body">
          {/* 看板打开时整叠藏起来而不卸载，见 `.side-stack` 的注释。 */}
          <Switch>
            <Match when={sidePanel() === 'files'}>
              <div id="workspace-files-panel" class="files-panel-body" role="tabpanel">
                <WorkspaceFileTree />
              </div>
            </Match>
            <Match when={sidePanel() === 'workflow'}>
              <div id="research-workflow-panel" class="workflow-panel-body" role="tabpanel">
                <WorkflowOverview />
              </div>
            </Match>
            <Match when={typeof sidePanel() !== 'string'}>
              {/* 可多开的页：全都在 DOM 里，只有当前那一页显示（`.tab-pane`）。 */}
              <div class="side-stack" role="tabpanel">
                <For each={panelTabs()}>
                  {(tab) => (
                    <div class="tab-pane" classList={{ active: activePanelTab() === tab.id }}>
                      <Suspense fallback={<div class="pane-loading" />}>
                        <Switch>
                          <Match when={tab.kind === 'conversation'}>
                            <ConversationPanel id={tab.id} />
                          </Match>
                          <Match when={tab.kind === 'cli'}>
                            <CliPanel id={tab.id} />
                          </Match>
                          <Match when={tab.kind === 'terminal'}>
                            <TerminalPanel id={tab.id} />
                          </Match>
                          <Match when={tab.kind === 'browser'}>
                            <iframe
                              class="panel-browser-frame"
                              src={panelTabUrl(tab.id)}
                              title={tab.title}
                            />
                          </Match>
                        </Switch>
                      </Suspense>
                    </div>
                  )}
                </For>
              </div>
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
  )
}
