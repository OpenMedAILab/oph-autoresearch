import { type ChatRequest, type LlmAdapter, ProviderError } from '@oph-autoresearch/ai'

const MAX_INPUT_CHARACTERS = 1_000_000
const MAX_OUTPUT_TOKENS = 1_000_000
function invalid(adapter: LlmAdapter, message: string): ProviderError {
  return new ProviderError({ code: 'invalid_request', message, provider: adapter.kind })
}
function requestCharacters(request: ChatRequest) {
  try {
    return JSON.stringify({
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
      effort: request.effort,
      cacheKey: request.cacheKey,
    }).length
  } catch {
    throw new Error('Research request cannot be serialized')
  }
}
export interface ResearchRequestGuard {
  wrap(adapter: LlmAdapter): LlmAdapter
}
export function makeResearchRequestGuard(options: {
  maxRequests: number
  maxOutputTokens: number
  maxInputCharacters: number
  beforeSend?: () => void
}): ResearchRequestGuard {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)
    throw new Error('maxRequests must be a positive integer')
  if (
    !Number.isSafeInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > MAX_OUTPUT_TOKENS
  )
    throw new Error('maxOutputTokens must be a bounded positive integer')
  if (
    !Number.isSafeInteger(options.maxInputCharacters) ||
    options.maxInputCharacters < 1 ||
    options.maxInputCharacters > MAX_INPUT_CHARACTERS
  )
    throw new Error('maxInputCharacters must be a bounded positive integer')
  options = Object.freeze({ ...options })
  let reserved = 0
  return {
    wrap(adapter) {
      const supportedOutput = adapter.spec.maxOutputTokens
      if (supportedOutput === null || !Number.isSafeInteger(supportedOutput) || supportedOutput < 1)
        throw invalid(adapter, 'Research adapter cannot prove an output bound')
      return {
        kind: adapter.kind,
        spec: adapter.spec,
        transmits: adapter.transmits,
        stream(request) {
          if (request.signal?.aborted)
            throw invalid(adapter, 'Research request was cancelled before send')
          if (reserved >= options.maxRequests)
            throw invalid(adapter, 'Research request limit reached')
          const characters = requestCharacters(request)
          if (characters > options.maxInputCharacters)
            throw invalid(adapter, 'Research request exceeds the input character limit')
          const requested = request.maxOutputTokens ?? options.maxOutputTokens
          if (!Number.isFinite(requested) || requested < 1)
            throw invalid(adapter, 'Research request requires a finite output bound')
          const output = Math.min(Math.floor(requested), options.maxOutputTokens, supportedOutput)
          if (output < 1)
            throw invalid(adapter, 'Research request requires a positive output bound')
          reserved++
          options.beforeSend?.()
          return forward(
            adapter.stream({ ...request, maxOutputTokens: output, hardOutputLimit: true }),
          )
        },
      }
    },
  }
}
async function* forward(
  stream: AsyncGenerator<unknown, void, unknown>,
): AsyncGenerator<never, void, unknown> {
  for await (const event of stream) yield event as never
}
