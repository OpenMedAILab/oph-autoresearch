import type { ChatRequest, LlmAdapter, ProviderEvent } from '@oph-autoresearch/ai'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { createConversation, Store, upsertWorkspace } from '@oph-autoresearch/store'
import { type EvidencePack, runLockedEvidenceReview } from './evidence-session.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

export interface EvidenceCliInput {
  schema: 'research-evidence-cli-v1'
  endpoint: string
  token: string
  pack: EvidencePack
  evidencePackHash: string
  config: OphConfig
  adapter: Pick<LlmAdapter, 'kind' | 'spec' | 'transmits'>
}

/** Code-owned CLI: no external CLI, parent workspace, provider key or resumable session is accepted. */
export async function runEvidenceCliWorker() {
  const bytes = await Bun.stdin.text()
  if (bytes.length > 2_000_000) throw new Error('Evidence CLI input exceeds contract')
  const input = JSON.parse(bytes) as EvidenceCliInput
  if (
    input.schema !== 'research-evidence-cli-v1' ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.endpoint) ||
    !/^[a-f0-9]{64}$/.test(input.token) ||
    sha256(canonicalJson(input.pack)) !== input.evidencePackHash
  )
    throw new Error('Invalid evidence CLI input')
  const adapter: LlmAdapter = {
    ...input.adapter,
    async *stream(request: ChatRequest) {
      const { signal, ...body } = request
      const response = await fetch(`${input.endpoint}/stream`, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
      if (!response.ok || !response.body)
        throw new Error('Parent research adapter rejected request')
      let pending = ''
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += chunk.value
          if (pending.length > 1_000_000) throw new Error('Evidence stream frame exceeds contract')
          while (pending.includes('\n')) {
            const newline = pending.indexOf('\n')
            const frame = JSON.parse(pending.slice(0, newline)) as {
              event?: ProviderEvent
              error?: string
            }
            pending = pending.slice(newline + 1)
            if (frame.error || !frame.event) throw new Error('Parent research provider failed')
            yield frame.event
          }
        }
        if (pending.length) throw new Error('Incomplete evidence stream')
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
  }
  const store = new Store({ path: ':memory:' })
  try {
    const workspace = upsertWorkspace(store, process.cwd(), 'isolated-evidence-cli')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: input.config.active.provider,
      model: input.config.active.model,
    })
    const result = await runLockedEvidenceReview({
      store,
      config: input.config,
      pack: input.pack,
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      signal: AbortSignal.timeout(110_000),
      maxSteps: 3,
      requestGuard: { wrap: () => adapter },
    })
    process.stdout.write(
      `${JSON.stringify({ schema: input.schema, workerPid: process.pid, result })}\n`,
    )
  } finally {
    store.close()
  }
}
if (import.meta.main) await runEvidenceCliWorker()
