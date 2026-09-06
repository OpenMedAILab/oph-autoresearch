import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'], document)
})
afterAll(() => GlobalRegistrator.unregister())
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.body.replaceChildren()
})
async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('UI did not settle')
    await Bun.sleep(5)
  }
}
async function mount() {
  const ui = await import('../lib/store/index.ts')
  const previous = ui.workspace()
  const binding = {
    version: 1 as const,
    profileId: 'fixture',
    remoteRoot: '/research/project-a',
    connectionHash: `sha256:${'a'.repeat(64)}`,
    verifiedAt: Date.now(),
  }
  ui.setWorkspace({
    id: 'workspace-a',
    root: '/local/a',
    name: 'project-a',
    pendingTrust: [],
    serverBinding: binding,
  })
  cleanups.push(() => ui.setWorkspace(previous))
  const { render } = await import('solid-js/web')
  const { default: RemoteSshBrowser } = await import('./RemoteSshBrowser.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <RemoteSshBrowser />, host)
  cleanups.push(dispose)
  return { host, ui }
}
function clickBound(host: HTMLElement) {
  Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent === '打开绑定目录')!
    .click()
}
test('绑定配置漂移时展示错误，不自动连接其他服务器', async () => {
  const { client } = await import('../lib/store/index.ts')
  const calls: string[] = []
  const api = spyOn(client, 'api').mockImplementation((async (path: string) => {
    calls.push(path)
    if (path === '/api/ssh/profiles') return { profiles: [], recentConnections: [] }
    throw new Error('服务器配置已变化')
  }) as typeof client.api)
  cleanups.push(() => api.mockRestore())
  const { host } = await mount()
  clickBound(host)
  await until(() => host.textContent?.includes('服务器配置已变化') ?? false)
  expect(calls.some((path) => path === '/api/ssh/connect')).toBe(false)
  expect(host.textContent).toContain('/research/project-a')
})
test('连接进行中切换项目后不接受旧服务器会话和目录响应', async () => {
  const { client } = await import('../lib/store/index.ts')
  const calls: string[] = []
  let resolveConnect!: (value: unknown) => void
  const pending = new Promise((resolve) => {
    resolveConnect = resolve
  })
  const api = spyOn(client, 'api').mockImplementation((async (path: string) => {
    calls.push(path)
    if (path === '/api/ssh/profiles') return { profiles: [], recentConnections: [] }
    if (path.endsWith('/server-binding'))
      return {
        profile: {
          id: 'fixture',
          name: 'fixture',
          host: 'fixture.example.org',
          port: 22,
          root: '/research/project-a',
          readOnly: false,
          hostKeyPolicy: 'strict',
        },
      }
    if (path === '/api/ssh/connect') return pending
    return { entries: [] }
  }) as typeof client.api)
  cleanups.push(() => api.mockRestore())
  const { host, ui } = await mount()
  clickBound(host)
  await until(() => calls.includes('/api/ssh/connect'))
  ui.setWorkspace({ id: 'workspace-b', root: '/local/b', name: 'project-b', pendingTrust: [] })
  resolveConnect({
    sessionId: 'old-session',
    home: '/home/fixture',
    message: '已连接旧服务器',
    target: { host: 'fixture.example.org', port: 22 },
  })
  await Bun.sleep(20)
  expect(calls.some((path) => path.includes('/api/ssh/session/list'))).toBe(false)
  expect(host.textContent).not.toContain('已连接旧服务器')
  expect(host.textContent).not.toContain('当前项目服务器目录')
})
