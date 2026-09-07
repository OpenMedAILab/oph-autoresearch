import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))

let dispose: (() => void) | undefined

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  const store = await import('../lib/store/index.ts')
  store.setSidePanel(null)
  store.setCenterView('chat')
  store.setSelectedResearchStage(0)
})

afterAll(async () => GlobalRegistrator.unregister())

describe('工作区右侧栏', () => {
  test('只呈现文件与流程两个一级视图，文件树在右栏', async () => {
    const store = await import('../lib/store/index.ts')
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(Array.from(tabs, (tab) => tab.textContent?.trim())).toEqual(['文件', '流程'])
    expect(host.querySelector('.workspace-file-tree')).not.toBeNull()
    expect(host.textContent).not.toContain('变更')
    expect(host.textContent).not.toContain('SSH 数据')
  })

  test('切到流程后点击阶段，详情在中央视图打开', async () => {
    const store = await import('../lib/store/index.ts')
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    const flowTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent?.trim() === '流程',
    )
    flowTab?.click()

    expect(store.sidePanel()).toBe('workflow')
    expect(host.querySelector('.workflow-overview-compact')).not.toBeNull()
    expect(host.querySelectorAll('.workflow-nav-list > li')).toHaveLength(6)

    const secondStage = host.querySelectorAll<HTMLButtonElement>('.workflow-nav-list button')[1]
    secondStage?.click()
    expect(store.selectedResearchStage()).toBe(1)
    expect(store.centerView()).toBe('research')
  })

  test('收起时不保留不可见的右栏外壳', async () => {
    const store = await import('../lib/store/index.ts')
    store.setSidePanel(null)

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    expect(host.querySelector('.side-panel')).toBeNull()
  })

  test('打开外部 CLI 页后，页签出现且正文渲染 CLI 输出', async () => {
    const store = await import('../lib/store/index.ts')
    store.setSidePanel('files')
    store.openCliTab('st_abc', 'codex', 'codex 运行')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    // 页签条里出现可关闭的那一页，且处于选中态
    const closable = host.querySelector('.side-tab.closable.active')
    expect(closable).not.toBeNull()
    expect(closable?.textContent).toContain('codex 运行')
    expect(host.querySelector('.tab-close')).not.toBeNull()

    // 正文渲染 CLI 面板（lazy 动态导入，轮询等它落地）
    for (let i = 0; i < 30 && !host.querySelector('.cli-pane'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(host.querySelector('.cli-pane')).not.toBeNull()
    expect(host.querySelector('.workspace-file-tree')).toBeNull()

    // 切回文件视图，CLI 页仍在页签条里，只是不显示
    store.setSidePanel('files')
    expect(host.querySelectorAll('.side-tab.closable')).toHaveLength(1)
    expect(host.querySelector('.workspace-file-tree')).not.toBeNull()
    expect(host.querySelector('.tab-pane.active')).toBeNull()

    // 关闭页签回文件视图，页签条清空
    host.querySelector<HTMLButtonElement>('.tab-close')?.click()
    expect(store.sidePanel()).toBe('files')
    expect(host.querySelectorAll('.side-tab.closable')).toHaveLength(0)
  })
})
