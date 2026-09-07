import { expect, test } from 'bun:test'
import { buildAdapter } from '@oph-autoresearch/ai'
import { runEvidenceCliReview } from './evidence-cli.ts'

test('cancellation during async scratch creation cannot spawn the CLI or dispatch a model request', async () => {
  const controller = new AbortController()
  const adapter = buildAdapter({
    kind: 'openai_responses',
    model: 'deepseek-v4-flash',
    apiKey: 'fixture-only',
  })
  let calls = 0
  const pending = runEvidenceCliReview({
    pack: { schema: 'research-evidence-pack-v1', artifactVersionIds: [], reports: [] },
    signal: controller.signal,
    config: {
      active: { provider: 'fixture', model: 'deepseek-v4-flash' },
      providers: {
        fixture: {
          kind: 'openai_responses',
          apiKey: 'fixture-only',
          models: { 'deepseek-v4-flash': {} },
        },
      },
    },
    adapter: {
      ...adapter,
      kind: adapter.kind,
      spec: adapter.spec,
      transmits: adapter.transmits,
      stream() {
        calls++
        throw new Error('must not send')
      },
    },
    workerArgv: [process.execPath, '--eval', 'throw new Error("must not spawn")'],
  })
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled before spawn')
  expect(calls).toBe(0)
})
