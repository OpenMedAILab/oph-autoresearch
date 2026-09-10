/** Runs the discovery smoke through a local scripted provider; never loads user model credentials. */
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { runDiscoverySmoke } from './smoke-research-discovery.ts'

test('discovery smoke records a complete local workflow and leaves scientific scoring to a human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oph-discovery-smoke-'))
  let calls = 0
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const prompt = await req.text()
      calls++
      const output = prompt.includes('输出契约：study')
        ? JSON.stringify({
            question: 'Fixture question',
            PICO: { population: 'unknown' },
            protocol: { stopRules: ['No execution'] },
            splitPlan: { unit: 'patient' },
            endpoints: ['AUROC'],
            evidenceCitations: ['fixture-unverified-citation'],
            counterEvidence: ['No clinical evidence'],
            codeVersion: 'unknown',
            previousVersion: null,
          })
        : 'Fixture evidence only; scientific validity unknown.'
      return new Response(
        [
          { type: 'response.created', response: { id: `sample-${calls}` } },
          { type: 'response.output_text.delta', delta: output },
          {
            type: 'response.completed',
            response: {
              id: `sample-${calls}`,
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 20 },
            },
          },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  try {
    const report = join(root, 'score.md')
    const result = await runDiscoverySmoke({
      root,
      report,
      goal: 'Synthetic fixture',
      signal: AbortSignal.timeout(30_000),
      config: {
        active: { provider: 'fake', model: 'deepseek-v4-flash' },
        providers: {
          fake: {
            apiKey: 'fixture',
            kind: 'openai_responses',
            baseUrl: `${provider.url}v1`,
            models: { 'deepseek-v4-flash': {} },
          },
        },
        mode: 'auto',
      } as OphConfig,
    })
    expect(result.outcome).toMatchObject({ status: 'success' })
    expect(result.outcome.data?.phase).toBe('waiting_review')
    expect(calls).toBe(7)
    expect(result.usage.conversationCount).toBe(8)
    expect(result.skillHashes['oph-study-protocol']).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(report, 'utf8')).toContain('待人工评分')
    expect(
      JSON.parse(await readFile(join(root, 'result.json'), 'utf8')).outcome.data.receipts,
    ).toHaveLength(7)
  } finally {
    provider.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
