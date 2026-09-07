/**
 * 从已配置接口读取它实际公开的模型列表。
 *
 * 前端只提交接口名和可选的 Base URL 草稿。凭证始终从服务端配置读取，既不下发，
 * 也不允许前端沿这条路径上传。接口采用 OpenAI 兼容的 `GET /models` 形状；
 * Anthropic Messages 接口使用同一路径，但改用其原生鉴权头。
 */

import type { ProviderKind } from '@oph-autoresearch/core'
import type { StoredProvider } from '@oph-autoresearch/runtime'
import { type ApiHandler, json } from './types.ts'

const DEFAULT_BASE: Record<ProviderKind, string> = {
  anthropic_messages: 'https://api.anthropic.com/v1',
  openai_chat_completions: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
}

export function providerModelsUrl(baseUrl: string | undefined, kind: ProviderKind): string {
  const url = new URL(baseUrl?.trim() || DEFAULT_BASE[kind])
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 只支持 http 或 https')
  }
  url.search = ''
  url.hash = ''
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(chat\/completions|responses|messages)$/i, '')
  if (!/\/models$/i.test(path)) path = `${path}/models`
  url.pathname = path.replace(/\/{2,}/g, '/')
  return url.toString()
}

function requestHeaders(provider: StoredProvider): Record<string, string> {
  const auth = provider.apiKey
    ? provider.kind === 'anthropic_messages'
      ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${provider.apiKey}` }
    : {}
  return { accept: 'application/json', ...auth, ...(provider.headers ?? {}) }
}

function parseModelIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return [
    ...new Set(
      data
        .map((row) =>
          row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
            ? (row as { id: string }).id.trim()
            : '',
        )
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b))
}

export const handleProviderModelsApi: ApiHandler = async (url, req, d) => {
  if (url.pathname !== '/api/provider-models' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as {
    provider?: string
    baseUrl?: string
  } | null
  if (!body?.provider) return json({ error: 'bad request', message: '缺少 provider' }, 400)
  const provider = d.config.providers[body.provider]
  if (!provider) return json({ error: 'not found', message: `接口「${body.provider}」不存在` }, 404)

  let endpoint: string
  try {
    endpoint = providerModelsUrl(body.baseUrl ?? provider.baseUrl, provider.kind)
  } catch (error) {
    return json(
      { error: 'invalid url', message: error instanceof Error ? error.message : 'Base URL 无效' },
      400,
    )
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: requestHeaders(provider),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return json({ error: 'unreachable', message: '无法连接模型列表地址，请检查 Base URL' }, 502)
  }
  if (!response.ok) {
    return json({ error: 'upstream', message: `模型接口返回 HTTP ${response.status}` }, 502)
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const models = parseModelIds(payload)
  if (!models.length) {
    return json({ error: 'invalid response', message: '接口没有返回 OpenAI 兼容的模型列表' }, 502)
  }
  return json({ models })
}
