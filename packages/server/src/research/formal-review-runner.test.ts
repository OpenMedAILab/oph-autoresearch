import { expect, test } from 'bun:test'
import {
  builtinCatalog,
  computeCost,
  type LlmAdapter,
  type ProviderEvent,
  type ProviderUsage,
} from '@oph-autoresearch/ai'
import type { FormalExecutionPlan } from '@oph-autoresearch/core'
import { createIsolatedFormalCodeReviewer } from './formal-review-runner.ts'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const plan: FormalExecutionPlan = {
  schema: 'research-formal-plan-v1',
  planId: 'plan',
  taskRevisionId: 'task',
  candidateArtifactId: 'artifact',
  codeHash: hash('a'),
  candidateReceiptHash: hash('b'),
  workspaceBindingHash: hash('c'),
  ociImageDigest: hash('d'),
  entryArgv: ['python3', 'main.py'],
  dataManifestHash: hash('e'),
  labelSetContentHash: hash('f'),
  trustedEvaluatorId: 'binary-classification-v1',
  trustedEvaluatorHash: hash('1'),
  resources: { maxRuntimeMs: 1000, cpu: 1, memoryMb: 128, pidsLimit: 10, network: 'disabled' },
  datasetMount: { target: '/dataset', readOnly: true },
  outputMount: { target: '/out' },
}

function adapter(usage: ProviderUsage | null): LlmAdapter {
  const spec = structuredClone(builtinCatalog().find((item) => item.maxOutputTokens !== null)!)
  spec.pricing = {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite5m: 3,
    cacheWrite1h: 4,
    currency: 'USD',
  }
  return {
    kind: spec.provider,
    spec,
    transmits: { effort: false },
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta' as const, delta: '{"decision":"accepted","findings":[]}' }
      if (usage) yield { type: 'usage' as const, usage }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'end_turn' }
    },
  }
}

test('formal runner records only provider-reported configured-price usage', async () => {
  const usage: ProviderUsage = {
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    source: 'provider',
  }
  const raw = adapter(usage)
  const reviewer = createIsolatedFormalCodeReviewer({
    adapter: raw,
    reviewerId: 'reviewer',
    quote: {
      configHash: hash('9'),
      reservedCost: 1,
      maxInputCharacters: 4096,
      maxOutputTokens: 64,
    },
  })
  const result = await reviewer.review({ code: 'x', plan, configHash: hash('9'), currency: 'USD' })
  expect(result.actualCost).toBe(computeCost(raw.spec, usage))
})

test('formal runner retains reservation when usage is estimated, missing, or invalid', async () => {
  const quote = {
    configHash: hash('9'),
    reservedCost: 1,
    maxInputCharacters: 4096,
    maxOutputTokens: 64,
  }
  for (const usage of [
    null,
    {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'estimated' as const,
    },
    {
      inputTokens: Number.NaN,
      outputTokens: 1,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'provider' as const,
    },
  ]) {
    const reviewer = createIsolatedFormalCodeReviewer({
      adapter: adapter(usage),
      reviewerId: 'reviewer',
      quote,
    })
    expect(
      (await reviewer.review({ code: 'x', plan, configHash: hash('9'), currency: 'USD' }))
        .actualCost,
    ).toBeNull()
  }
})
