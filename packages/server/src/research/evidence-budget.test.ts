import { expect, test } from 'bun:test'
import { builtinCatalog, computeCost, type ModelSpec, unknownModel } from '@oph-autoresearch/ai'
import { evidenceBudget } from './evidence-budget.ts'

function known(): ModelSpec {
  const spec = structuredClone(builtinCatalog().find((row) => row.maxOutputTokens !== null)!)
  spec.contextWindow = 100_000
  spec.maxOutputTokens = 10_000
  spec.pricing = {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite5m: 3,
    cacheWrite1h: 4,
    currency: 'USD',
  }
  delete spec.offPeak
  spec.longContext = [
    { thresholdTokens: 50_000, input: 5, output: 8, cacheRead: 6, note: 'test tier' },
  ]
  return spec
}

function quote(spec = known()) {
  return {
    profile: {
      kind: spec.provider,
      model: spec.id,
      apiKey: 'private-test-key',
      baseUrl: 'https://example.test/v1',
      headers: { Authorization: 'private-test-header' },
    },
    spec,
    currency: 'USD',
    maxRequests: 2,
    maxOutputTokens: 1_000,
  }
}

test('reserves all requests at the most expensive input/cache and output tiers', () => {
  const options = quote()
  const result = evidenceBudget(options)
  expect(result.reservedCost).toBe(1.216)
  // Independent provider accounting must remain below the reservation, including
  // the long-context cached-input tier, not just a no-cache baseline example.
  for (const usage of [
    { inputTokens: 100_000, outputTokens: 1_000 },
    { inputTokens: 0, cachedTokens: 100_000, outputTokens: 1_000 },
    { inputTokens: 0, cacheWriteTokens: 100_000, outputTokens: 1_000 },
  ])
    expect(computeCost(options.spec, usage) * 2).toBeLessThanOrEqual(result.reservedCost)
})

test('public config fingerprint changes for route, price and request bounds but excludes secrets', () => {
  const options = quote()
  const original = evidenceBudget(options)
  options.profile.apiKey = 'rotated-private-key'
  options.profile.headers.Authorization = 'rotated-header'
  expect(evidenceBudget(options).configHash).toBe(original.configHash)
  expect(JSON.stringify(original)).not.toContain('private')
  options.profile.baseUrl = 'https://another.test/v1'
  expect(evidenceBudget(options).configHash).not.toBe(original.configHash)
  options.profile.baseUrl = 'https://example.test/v1'
  options.maxRequests = 1
  expect(evidenceBudget(options).configHash).not.toBe(original.configHash)
  options.maxRequests = 2
  options.spec.pricing.output = 20
  expect(evidenceBudget(options).configHash).not.toBe(original.configHash)
})

test('unknown, incomplete, nonfinite or unsupported budgets fail before any dispatch', () => {
  const changes: Array<(value: ReturnType<typeof quote>) => void> = [
    (v) => {
      v.spec = unknownModel(v.spec.id, v.spec.provider)
    },
    (v) => {
      v.currency = 'CNY'
    },
    (v) => {
      v.spec.pricing.input = NaN
    },
    (v) => {
      v.spec.pricing.output = -1
    },
    (v) => {
      v.spec.maxOutputTokens = null
    },
    (v) => {
      v.maxRequests = 0
    },
    (v) => {
      v.maxRequests = Infinity
    },
    (v) => {
      v.maxOutputTokens = 10_001
    },
    (v) => {
      v.spec.contextWindow = Number.MAX_SAFE_INTEGER
    },
    (v) => {
      v.profile.model = 'mismatched'
    },
    (v) => {
      v.profile.baseUrl = 'https://secret@example.test/v1'
    },
    (v) => {
      v.profile.baseUrl = 'https://example.test/v1?key=secret'
    },
  ]
  for (const change of changes) {
    const options = quote()
    change(options)
    expect(() => evidenceBudget(options)).toThrow()
  }
})
