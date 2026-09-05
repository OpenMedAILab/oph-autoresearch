import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SummaryTrace } from '@oph-autoresearch/agent'
import type { ProviderProfile, ProviderUsage } from '@oph-autoresearch/ai'
import { createConversation, Store, upsertWorkspace, usageEntries } from '@oph-autoresearch/store'
import { makeSummarizer } from './session.ts'

type Reply = () => Response
const replies: Reply[] = []
let server: ReturnType<typeof Bun.serve>
let baseUrl = ''
let providerCalls = 0
let requestSeen: (() => void) | undefined

function sse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

const providerUsage = { prompt_tokens: 7, completion_tokens: 3 }
const finished = () =>
  sse([
    { choices: [{ delta: { content: '摘要' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: providerUsage },
  ])

const noUsage = () =>
  sse([
    { choices: [{ delta: { content: '摘要' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])

const providerZeroUsage = () =>
  sse([
    { choices: [{ delta: { content: '摘要' }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
  ])

const missingFinish = () =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: '摘要' }, finish_reason: null }],
      usage: providerUsage,
    })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )

const waitForAbort = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: null }],
              usage: providerUsage,
            })}\n\n`,
          ),
        )
        // Leave the stream live: the user cancels after the real usage frame but before finish.
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text()
      providerCalls++
      requestSeen?.()
      const reply = replies.shift()
      if (!reply) throw new Error('test provider received an unexpected request')
      return reply()
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server.stop(true))

function fresh() {
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, '/tmp/summary-trace', 'summary-trace')
  const conversation = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'summary-provider',
    model: 'deepseek-v4-flash',
  })
  const profile: ProviderProfile = {
    kind: 'openai_chat_completions',
    apiKey: 'sk-test',
    baseUrl,
    model: 'deepseek-v4-flash',
  }
  return { store, workspace, conversation, profile }
}

function summarizer(
  store: Store,
  workspaceId: string,
  conversationId: string,
  profile: ProviderProfile,
  signal?: AbortSignal,
) {
  return makeSummarizer({
    store,
    workspaceId,
    conversationId: conversationId as never,
    profile: () => profile,
    providerName: () => 'summary-provider',
    ...(signal ? { signal } : {}),
  })
}

describe('summary trace settlement', () => {
  test('manual summaries write one ledger row, while traced summaries settle the in-run trace with the actual source model', async () => {
    const { store, workspace, conversation, profile } = fresh()
    try {
      replies.push(finished, finished)
      const summarize = summarizer(store, workspace.id, conversation.id, profile)
      await expect(summarize('manual', 32)).resolves.toBe('摘要')
      expect(usageEntries(store, { kind: 'summary' })).toMatchObject([
        {
          model: 'deepseek-v4-flash',
          inputTokens: 7,
          outputTokens: 3,
        },
      ])

      let source: { model: string; providerName?: string } | undefined
      let settled: { status: string; usage: ProviderUsage | null } | undefined
      const trace: SummaryTrace = {
        open: (_request, supplied) => {
          if (!supplied) throw new Error('summary trace must receive its actual adapter source')
          source = {
            model: supplied.adapter.spec.id,
            ...(supplied.providerName ? { providerName: supplied.providerName } : {}),
          }
          return 'pr_summary'
        },
        sent: () => {},
        firstEvent: () => {},
        settle: (_id, status, usage) => {
          settled = { status, usage }
        },
      }
      await expect(summarize('traced', 32, trace)).resolves.toBe('摘要')
      expect(usageEntries(store, { kind: 'summary' })).toHaveLength(1)
      expect(source).toEqual({ model: 'deepseek-v4-flash', providerName: 'summary-provider' })
      expect(settled).toMatchObject({
        status: 'received',
        usage: { inputTokens: 7, outputTokens: 3 },
      })
    } finally {
      store.close()
    }
  })

  test('a failed summary preserves usage that arrived before the missing finish event', async () => {
    const { store, workspace, conversation, profile } = fresh()
    try {
      replies.push(missingFinish)
      const summarize = summarizer(store, workspace.id, conversation.id, profile)
      await expect(summarize('failure', 32)).rejects.toThrow('finish_reason')
      expect(usageEntries(store, { kind: 'summary' })).toMatchObject([
        { inputTokens: 7, outputTokens: 3, model: 'deepseek-v4-flash' },
      ])
    } finally {
      store.close()
    }
  })

  test('missing provider usage does not create an estimated zero manual row or trace usage', async () => {
    const { store, workspace, conversation, profile } = fresh()
    let settled: ProviderUsage | null | undefined
    const trace: SummaryTrace = {
      open: () => 'pr_no_usage',
      sent: () => {},
      firstEvent: () => {},
      settle: (_id, _status, usage) => {
        settled = usage
      },
    }
    try {
      replies.push(noUsage, noUsage)
      const summarize = summarizer(store, workspace.id, conversation.id, profile)
      await expect(summarize('manual missing usage', 32)).resolves.toBe('摘要')
      await expect(summarize('traced missing usage', 32, trace)).resolves.toBe('摘要')
      expect(usageEntries(store, { kind: 'summary' })).toEqual([])
      expect(settled).toBeNull()
    } finally {
      store.close()
    }
  })

  test('a provider-reported real zero remains a recorded zero usage', async () => {
    const { store, workspace, conversation, profile } = fresh()
    try {
      replies.push(providerZeroUsage)
      await expect(
        summarizer(store, workspace.id, conversation.id, profile)('zero', 32),
      ).resolves.toBe('摘要')
      expect(usageEntries(store, { kind: 'summary' })).toMatchObject([
        { inputTokens: 0, outputTokens: 0, model: 'deepseek-v4-flash' },
      ])
    } finally {
      store.close()
    }
  })

  test('an already-aborted summary creates no provider request, trace, or ledger row', async () => {
    const { store, workspace, conversation, profile } = fresh()
    const abort = new AbortController()
    abort.abort()
    const before = providerCalls
    const trace = {
      open: () => {
        throw new Error('pre-cancelled summary must not open')
      },
      sent: () => {
        throw new Error('pre-cancelled summary must not send')
      },
      firstEvent: () => {},
      settle: () => {
        throw new Error('pre-cancelled summary must not settle')
      },
    } satisfies SummaryTrace
    try {
      await expect(
        summarizer(
          store,
          workspace.id,
          conversation.id,
          profile,
          abort.signal,
        )('cancelled', 32, trace),
      ).rejects.toThrow()
      expect(providerCalls).toBe(before)
      expect(usageEntries(store, { kind: 'summary' })).toEqual([])
    } finally {
      store.close()
    }
  })

  test('an already-sent summary cancelled after an SSE usage frame settles uncertain with usage', async () => {
    const { store, workspace, conversation, profile } = fresh()
    const abort = new AbortController()
    const before = providerCalls
    const seen = new Promise<void>((resolve) => {
      requestSeen = resolve
    })
    const transitions: string[] = []
    const trace: SummaryTrace = {
      open: () => {
        transitions.push('open')
        return 'pr_cancelled'
      },
      sent: () => transitions.push('sent'),
      firstEvent: () => transitions.push('first-event'),
      settle: (_id, status, usage) => transitions.push(`${status}:${usage ? 'usage' : 'none'}`),
    }
    try {
      replies.push(waitForAbort)
      const pending = summarizer(
        store,
        workspace.id,
        conversation.id,
        profile,
        abort.signal,
      )('cancelled after send', 32, trace)
      await seen
      // The endpoint has sent a usage frame; give the SDK one turn to parse it before aborting.
      await Bun.sleep(10)
      abort.abort()
      await expect(pending).rejects.toThrow()
      expect(providerCalls).toBe(before + 1)
      expect(transitions).toEqual(['open', 'sent', 'first-event', 'uncertain:usage'])
      expect(usageEntries(store, { kind: 'summary' })).toEqual([])
    } finally {
      requestSeen = undefined
      store.close()
    }
  })
})
