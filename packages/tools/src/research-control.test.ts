import { expect, test } from 'bun:test'
import { researchControlTool } from './research-control.ts'

test('research_control is registered only with a scoped port and cannot request approval', async () => {
  const calls: unknown[] = []
  const ctx = {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'run',
    model: 'test',
    contextWindow: 100_000,
    density: 'normal',
    vision: false,
    resources: new Map(),
    state: new Map(),
    sink: null,
    researchControl: {
      execute: async (input: unknown) => {
        calls.push(input)
        return { ok: true, status: 202, data: { attemptId: 'attempt' } }
      },
    },
  } as never
  const accepted = await researchControlTool.fn(
    {
      operation: 'submit',
      campaign_id: 'campaign',
      body: { expectedVersion: 1, idempotencyKey: 'once' },
    },
    ctx,
  )
  expect(accepted.status).toBe('success')
  expect(calls).toHaveLength(1)
  const rejected = await researchControlTool.fn(
    { operation: 'approve', campaign_id: 'campaign' },
    ctx,
  )
  expect(rejected.status).toBe('failure')
  expect(calls).toHaveLength(1)
})
