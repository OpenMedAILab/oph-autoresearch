import { afterEach, describe, expect, test } from 'bun:test'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { handleProviderModelsApi, providerModelsUrl } from './provider-models.ts'
import type { ApiDeps } from './types.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const config = (): OphConfig => ({
  active: { provider: 'deepseek', model: 'old' },
  providers: {
    deepseek: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-private-value',
      models: {},
    },
  },
})

const call = (body: unknown, cfg = config()) => {
  const url = new URL('http://127.0.0.1/api/provider-models')
  return handleProviderModelsApi(
    url,
    new Request(url.href, { method: 'POST', body: JSON.stringify(body) }),
    { config: cfg } as unknown as ApiDeps as never,
  )
}

describe('模型列表 URL', () => {
  test('根地址与 v1 地址各自追加 models', () => {
    expect(providerModelsUrl('https://api.deepseek.com', 'openai_chat_completions')).toBe(
      'https://api.deepseek.com/models',
    )
    expect(providerModelsUrl('https://api.deepseek.com/v1/', 'openai_chat_completions')).toBe(
      'https://api.deepseek.com/v1/models',
    )
  })

  test('传入完整请求端点时先收回接口根', () => {
    expect(
      providerModelsUrl('https://relay.example/v1/chat/completions', 'openai_chat_completions'),
    ).toBe('https://relay.example/v1/models')
  })
})

describe('从接口读取模型', () => {
  test('使用服务端凭证，并返回去重排序后的模型 id', async () => {
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      expect(String(input)).toBe('https://api.deepseek.com/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-private-value')
      return Response.json({
        data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
      })
    }) as unknown as typeof fetch

    const response = await call({ provider: 'deepseek' })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    })
  })

  test('URL 草稿可直接用于获取，不要求先落盘', async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe('https://api.deepseek.com/v1/models')
      return Response.json({ data: [{ id: 'm' }] })
    }) as unknown as typeof fetch
    expect(
      (await call({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }))?.status,
    ).toBe(200)
  })

  test('控制台页面或非兼容响应不会被当成一个模型', async () => {
    globalThis.fetch = (async () => new Response('<html>console</html>')) as unknown as typeof fetch
    const response = await call({ provider: 'deepseek', baseUrl: 'https://platform.deepseek.com' })
    expect(response?.status).toBe(502)
    expect(JSON.stringify(await response?.json())).not.toContain('sk-private-value')
  })
})
