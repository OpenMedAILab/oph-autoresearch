import type { ModelSpec, ProviderProfile } from '@oph-autoresearch/ai'
import { canonicalJson, sha256 } from './skill-lock.ts'

export interface EvidenceBudget {
  currency: 'USD' | 'CNY'
  reservedCost: number
  maxRequests: number
  maxInputTokens: number
  maxOutputTokens: number
  configHash: string
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`)
  return value
}

function price(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Unknown or invalid model price')
  return value
}

/** Reservation at configured prices, not a guarantee of an upstream provider's bill.
 * The consumer must atomically reserve this amount before sending and enforce these
 * limits across every adapter call, including retry and compaction. Unknown usage
 * retains its reservation. Input/cache categories are mutually exclusive.
 */
export function evidenceBudget(options: {
  profile: ProviderProfile
  spec: ModelSpec
  currency: string
  maxRequests: number
  maxOutputTokens: number
}): EvidenceBudget {
  const { profile, spec } = options
  if (spec.catalogued === false || spec.id !== profile.model || spec.provider !== profile.kind)
    throw new Error('Evidence review requires a known matching model specification')
  const currency = spec.pricing.currency ?? 'USD'
  if (!['USD', 'CNY'].includes(currency) || currency !== options.currency)
    throw new Error('Evidence review budget currency mismatch')
  const maxRequests = positiveInteger(options.maxRequests, 'maxRequests')
  const maxInputTokens = positiveInteger(spec.contextWindow, 'contextWindow')
  const maxOutputTokens = positiveInteger(options.maxOutputTokens, 'maxOutputTokens')
  if (
    spec.maxOutputTokens === null ||
    maxOutputTokens > positiveInteger(spec.maxOutputTokens, 'model output limit') ||
    maxOutputTokens > maxInputTokens
  )
    throw new Error('Evidence review output limit is not supported')

  const base = spec.pricing
  // Reserve against every configured tier and either time window, regardless of
  // current prompt size. The actual request can grow or cross a pricing window.
  let inputRate = Math.max(
    price(base.input),
    price(base.cacheRead),
    price(base.cacheWrite5m),
    price(base.cacheWrite1h),
  )
  let outputRate = price(base.output)
  for (const tier of spec.longContext ?? []) {
    inputRate = Math.max(
      inputRate,
      price(tier.input),
      price(tier.cacheRead),
      price(tier.cacheWrite5m ?? base.cacheWrite5m),
      price(tier.cacheWrite1h ?? base.cacheWrite1h),
    )
    outputRate = Math.max(outputRate, price(tier.output))
  }
  const windowRate = spec.offPeak ? Math.max(1, price(spec.offPeak.rate)) : 1
  if (inputRate === 0 || outputRate === 0)
    throw new Error('Zero prices require separate trusted free-service authorization')
  const microUnits =
    (maxInputTokens * inputRate + maxOutputTokens * outputRate) * windowRate * maxRequests
  if (!Number.isFinite(microUnits) || microUnits > Number.MAX_SAFE_INTEGER)
    throw new Error('Evidence review reservation exceeds supported range')
  const reservedCost = Math.ceil(microUnits) / 1e6

  // Never serialize API keys or headers into a public fingerprint. Credentials in
  // endpoint userinfo/query are rejected rather than silently hiding routing data.
  let baseUrl: string | null = null
  if (profile.baseUrl) {
    const endpoint = new URL(profile.baseUrl)
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('Evidence review requires a public endpoint without URL credentials')
    baseUrl = endpoint.href
  }
  const configHash = sha256(
    canonicalJson({
      provider: profile.kind,
      baseUrl,
      model: profile.model,
      spec,
      transport: { effort: profile.transport?.effort ?? null },
      maxRequests,
      maxOutputTokens,
    }),
  )
  return { currency, reservedCost, maxRequests, maxInputTokens, maxOutputTokens, configHash }
}
