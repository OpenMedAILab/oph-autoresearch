/** 覆盖 ModelSetupNotice、ConfigStatus 与共享配置读取：引导入口、配置更新及真实错误。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => GlobalRegistrator.unregister())

test('待配置显示引导并打开模型设置；配置完成自动消失，真实错误仍显示', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { ConfigStatus } = await import('./ConfigStatus.tsx')
  const { reloadConfig } = await import('./configStore.ts')
  const originalApi = store.client.api
  const payload = {
    path: 'config.json',
    config: {
      active: { provider: 'p', model: 'm' },
      providers: { p: { kind: 'openai_chat_completions', models: { m: {} }, hasApiKey: false } },
    },
    notices: [],
    problems: [] as string[],
    setupRequired: true,
    defaultEnvAllowList: [],
  }
  store.client.api = async <T,>(path: string) => {
    if (path === '/api/config') return structuredClone(payload) as T
    throw new Error(`unexpected ${path}`)
  }
  const host = document.createElement('div')
  document.body.append(host)
  store.closeSettings()
  await reloadConfig()
  const dispose = render(() => <ConfigStatus />, host)
  try {
    expect(host.textContent).toContain('开始前，请先配置模型')
    expect(host.querySelector('.settings-notices.bad')).toBeNull()
    const button = host.querySelector('button')!
    expect(button.textContent).toBe('配置模型')
    const event = new MouseEvent('click', { bubbles: true })
    const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
    if (delegated) delegated.call(button, event)
    else button.dispatchEvent(event)
    expect(store.settingsPage()).toBe('models')
    expect(host.querySelector('button')).toBeNull()

    payload.setupRequired = false
    payload.config.providers.p.hasApiKey = true
    await reloadConfig()
    expect(host.querySelector('.model-setup-notice')).toBeNull()

    payload.problems = ['思考强度不是有效值']
    await reloadConfig()
    expect(host.querySelector('.settings-notices.bad')?.textContent).toContain('思考强度不是有效值')
    expect(host.querySelector('.model-setup-notice')).toBeNull()
  } finally {
    payload.problems = []
    await reloadConfig()
    dispose()
    store.closeSettings()
    store.client.api = originalApi
    host.remove()
  }
})
