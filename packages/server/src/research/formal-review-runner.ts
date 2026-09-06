import { createHash } from 'node:crypto'
import { buildAdapter, type LlmAdapter, type ProviderProfile } from '@oph-autoresearch/ai'
import type { FormalCodeReviewResult, FormalExecutionPlan } from '@oph-autoresearch/core'
import { type OphConfig, resolveModel } from '@oph-autoresearch/runtime'

type RunnerOutput = Pick<FormalCodeReviewResult, 'decision' | 'findings'>

/** Narrow paid-review port: it exposes only candidate code and a digest-only plan. */
export interface IsolatedFormalCodeReviewer {
  review(input: { code: string; plan: FormalExecutionPlan }): Promise<{
    reviewerId: string
    decision: FormalCodeReviewResult['decision']
    findings: FormalCodeReviewResult['findings']
    runnerReceiptHash: string
  }>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function parseOutput(value: unknown): RunnerOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join(',') !== 'decision,findings' ||
    !['accepted', 'rejected', 'needs_changes'].includes(String(row.decision)) ||
    !Array.isArray(row.findings) ||
    row.findings.length > 100
  )
    return null
  const findings = row.findings.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const finding = item as Record<string, unknown>
    if (
      Object.keys(finding).sort().join(',') !== 'code,message,severity' ||
      !['info', 'warning', 'error'].includes(String(finding.severity)) ||
      typeof finding.code !== 'string' ||
      finding.code.length > 128 ||
      typeof finding.message !== 'string' ||
      finding.message.length > 4000
    )
      return null
    return finding as FormalCodeReviewResult['findings'][number]
  })
  if (findings.some((item) => item === null)) return null
  if (row.decision === 'accepted' && findings.some((item) => item!.severity === 'error'))
    return null
  return {
    decision: row.decision as RunnerOutput['decision'],
    findings: findings as RunnerOutput['findings'],
  }
}

/** One adapter call: no Session, conversation, event history, tools, files, or ambient workspace state. */
export function createIsolatedFormalCodeReviewer(input: {
  adapter: LlmAdapter
  reviewerId: string
  signal?: AbortSignal
}): IsolatedFormalCodeReviewer {
  if (!input.reviewerId || input.reviewerId.length > 128) throw new Error('invalid formal reviewer')
  return {
    async review({ code, plan }) {
      let text = ''
      for await (const event of input.adapter.stream({
        model: input.adapter.spec.id,
        system: [
          {
            text: 'You are an isolated code reviewer. You have no tools, conversation history, files, or authority to approve, execute, or release research. Review only supplied code and plan. Return exactly JSON {"decision":"accepted|rejected|needs_changes","findings":[{"severity":"info|warning|error","code":"short-id","message":"brief"}]}.',
          },
        ],
        messages: [{ role: 'user', content: JSON.stringify({ code, plan }) }],
        tools: [],
        maxOutputTokens: 1024,
        hardOutputLimit: true,
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        if (event.type === 'tool_calls') throw new Error('isolated reviewer attempted a tool call')
        if (event.type === 'text_delta') {
          text += event.delta
          if (Buffer.byteLength(text, 'utf8') > 32_000)
            throw new Error('formal review exceeds output cap')
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('isolated reviewer returned invalid JSON')
      }
      const output = parseOutput(parsed)
      if (!output) throw new Error('isolated reviewer violated the result contract')
      const runnerReceiptHash = `sha256:${createHash('sha256').update(canonical({ plan, output })).digest('hex')}`
      return { ...output, reviewerId: input.reviewerId, runnerReceiptHash }
    },
  }
}

/** Lazy construction prevents service startup from sending an API request. */
export function createConfiguredIsolatedFormalCodeReviewer(
  config: OphConfig,
): IsolatedFormalCodeReviewer {
  return {
    async review(input) {
      const resolved = resolveModel(structuredClone(config))
      if (!resolved) throw new Error('formal reviewer model is not configured')
      const profile: ProviderProfile = {
        kind: resolved.kind,
        model: resolved.model,
        apiKey: resolved.apiKey ?? '',
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.spec ? { spec: resolved.spec } : {}),
        ...(resolved.transport ? { transport: resolved.transport } : {}),
      }
      return createIsolatedFormalCodeReviewer({
        adapter: buildAdapter(profile),
        reviewerId: `formal-api:${resolved.kind}:${resolved.model}`,
      }).review(input)
    },
  }
}

export { parseOutput as parseIsolatedFormalCodeReviewOutput }
