import { describe, expect, test } from 'bun:test'
import {
  buildAdapter,
  builtinCatalog,
  type ChatRequest,
  type LlmAdapter,
  ProviderError,
} from '@oph-autoresearch/ai'
import { makeResearchRequestGuard } from './research-request-guard.ts'

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'fixed',
  system: [{ text: 'system' }],
  messages: [{ role: 'user', content: 'review' }],
  tools: [],
  maxOutputTokens: null,
  ...over,
})
function fake(calls: ChatRequest[]): LlmAdapter {
  return {
    kind: 'openai_responses',
    spec: { id: 'fixed', maxOutputTokens: 64 } as LlmAdapter['spec'],
    transmits: { effort: false },
    stream(req) {
      calls.push(req)
      return events()
    },
  }
}
async function* events() {
  yield { type: 'text_delta', delta: 'ok' } as never
  yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'stop' } as never
}
describe('research request guard', () => {
  test('approved hard caps reach the actual wire even when Anthropic normally raises thinking budgets', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push((await request.json()) as Record<string, unknown>)
        return Response.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'wire captured' } },
          { status: 400 },
        )
      },
    })
    try {
      for (const kind of [
        'anthropic_messages',
        'openai_responses',
        'openai_chat_completions',
      ] as const) {
        const spec = builtinCatalog().find(
          (spec) => spec.provider === kind && spec.thinksByDefault && spec.maxOutputTokens !== null,
        )!
        expect(spec).toBeDefined()
        const guarded = makeResearchRequestGuard({
          maxRequests: 1,
          maxOutputTokens: 1024,
          maxInputCharacters: 10_000,
        }).wrap(buildAdapter({ kind, model: spec.id, apiKey: 'fixture', baseUrl: server.url.href }))
        await expect(
          Array.fromAsync(guarded.stream(request({ model: spec.id, maxOutputTokens: 1024 }))),
        ).rejects.toThrow()
        const body = bodies.at(-1)!
        expect(body[kind === 'openai_responses' ? 'max_output_tokens' : 'max_tokens']).toBe(1024)
        expect(body.hardOutputLimit).toBeUndefined()
      }
      expect(bodies).toHaveLength(3)
    } finally {
      server.stop(true)
    }
  })
  test('shares a synchronous one-request reservation across wrapped main and summary adapters', async () => {
    const calls: ChatRequest[] = []
    const guard = makeResearchRequestGuard({
      maxRequests: 1,
      maxOutputTokens: 12,
      maxInputCharacters: 500,
    })
    const main = guard.wrap(fake(calls))
    const summary = guard.wrap(fake(calls))
    const first = main.stream(request())
    expect(calls).toHaveLength(1)
    expect(() => summary.stream(request())).toThrow(ProviderError)
    await Array.fromAsync(first)
    expect(calls).toHaveLength(1)
  })
  test('clamps a null or excessive request output bound before forwarding unchanged events', async () => {
    const calls: ChatRequest[] = []
    const guarded = makeResearchRequestGuard({
      maxRequests: 1,
      maxOutputTokens: 12,
      maxInputCharacters: 500,
    }).wrap(fake(calls))
    const received = await Array.fromAsync(guarded.stream(request({ maxOutputTokens: 99 })))
    expect(calls[0]!.maxOutputTokens).toBe(12)
    expect(received.map((event) => (event as { type: string }).type)).toEqual([
      'text_delta',
      'done',
    ])
  })
  test('rejects oversized input and aborted requests before an adapter call', () => {
    const calls: ChatRequest[] = []
    const guarded = makeResearchRequestGuard({
      maxRequests: 1,
      maxOutputTokens: 12,
      maxInputCharacters: 80,
    }).wrap(fake(calls))
    expect(() =>
      guarded.stream(request({ messages: [{ role: 'user', content: 'x'.repeat(100) }] })),
    ).toThrow('input character')
    const controller = new AbortController()
    controller.abort()
    expect(() => guarded.stream(request({ signal: controller.signal }))).toThrow('cancelled')
    expect(calls).toHaveLength(0)
  })
  test('rejects adapters without a provable output maximum', () => {
    const calls: ChatRequest[] = []
    const unbounded = fake(calls) as LlmAdapter & { spec: { maxOutputTokens: null } }
    unbounded.spec = { ...unbounded.spec, maxOutputTokens: null }
    expect(() =>
      makeResearchRequestGuard({
        maxRequests: 1,
        maxOutputTokens: 12,
        maxInputCharacters: 80,
      }).wrap(unbounded),
    ).toThrow('output bound')
  })
})
