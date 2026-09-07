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
  const documents = await researchControlTool.fn(
    { operation: 'documents/read', campaign_id: 'campaign' },
    ctx,
  )
  expect(documents.status).toBe('success')
  expect(calls).toHaveLength(2)
  const rejected = await researchControlTool.fn(
    { operation: 'approve', campaign_id: 'campaign' },
    ctx,
  )
  expect(rejected.status).toBe('failure')
  expect(calls).toHaveLength(2)

  const discovery = await researchControlTool.fn({ operation: 'list' }, ctx)
  const readiness = await researchControlTool.fn({ operation: 'preflight' }, ctx)
  const omittedCampaign = await researchControlTool.fn({ operation: 'status' }, ctx)
  expect(discovery.status).toBe('success')
  expect(readiness.status).toBe('success')
  expect(omittedCampaign.status).toBe('success')
  expect(calls.slice(-3)).toEqual([
    { operation: 'list', campaignId: '' },
    { operation: 'preflight', campaignId: '' },
    { operation: 'status', campaignId: '' },
  ])
})

test('nullable optional fields from strict model schemas are treated as omitted', async () => {
  const calls: unknown[] = []
  const ctx = {
    researchControl: {
      execute: async (input: unknown) => {
        calls.push(input)
        return { ok: true, status: 200, data: {} }
      },
    },
  } as never
  expect(
    (await researchControlTool.fn({ operation: 'list', campaign_id: null, body: null }, ctx))
      .status,
  ).toBe('success')
  expect(
    (await researchControlTool.fn({ operation: 'status', campaign_id: null, body: null }, ctx))
      .status,
  ).toBe('success')
  expect(calls).toEqual([
    { operation: 'list', campaignId: '' },
    { operation: 'status', campaignId: '' },
  ])
  expect(
    (await researchControlTool.fn({ operation: 'status', campaign_id: 123 }, ctx)).status,
  ).toBe('failure')
})
