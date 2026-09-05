import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OphConfig } from '@oph-autoresearch/runtime'
import {
  appendMessage,
  createConversation,
  createResearchCampaign,
  getConversation,
  listRuns,
  mostRecentWorkspace,
  Store,
  upsertWorkspace,
  usageEntries,
} from '@oph-autoresearch/store'
import { buildEvidencePack, runEvidenceReview } from './evidence-session.ts'
import { syntheticProtocol } from './synthetic-protocol.ts'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

function responseSse(text: string) {
  const events = [
    { type: 'response.created', response: { id: 'evidence-review' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'evidence-review',
        status: 'completed',
        usage: { input_tokens: 31, output_tokens: 7 },
      },
    },
  ]
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')}\n`
}

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'oph-evidence-session-'))
  roots.push(root)
  const canary = `private-workspace-canary-${crypto.randomUUID()}`
  await writeFile(join(root, 'clinical.txt'), canary)
  await mkdir(join(root, '.agents', 'memory'), { recursive: true })
  await writeFile(join(root, '.agents', 'memory', 'global.md'), canary)
  const store = new Store({ path: ':memory:' })
  const workspace = upsertWorkspace(store, root, 'evidence-session')
  const parent = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'fake',
    model: 'fake',
  })
  appendMessage(store, { conversationId: parent.id, role: 'user', content: canary })
  const created = createResearchCampaign(store, {
    idempotencyKey: 'evidence-session-campaign',
    workspaceId: workspace.id,
    parentConversationId: parent.id,
    goal: canary,
    policy: {},
    inputs: { private: canary },
    budget: { currency: 'USD', limit: 0 },
  })
  if (!created.ok) throw new Error(created.message)
  const protocol = syntheticProtocol(store, root, created.campaign.id)
  const submitted = await protocol.submit({
    expectedVersion: created.campaign.version,
    dispatchKey: 'fixed-summary',
    templateId: 'synthetic-summary-v1',
  })
  if (!submitted.ok) throw new Error(submitted.error)
  return {
    root,
    store,
    campaign: submitted.campaign,
    parent,
    attemptId: submitted.attemptId,
    canary,
  }
}

describe('evidence-only review session', () => {
  test('revalidates actual completed receipts into a pinned aggregate-only evidence pack', async () => {
    const { root, store, campaign, attemptId, canary } = await fresh()
    const pack = await buildEvidencePack(store, root, campaign.id, [attemptId])
    expect(pack).toMatchObject({
      schema: 'research-evidence-pack-v1',
      artifactVersionIds: [expect.any(String)],
    })
    expect(pack.reports).toMatchObject([
      {
        attemptId,
        templateId: 'synthetic-summary-v1',
        inputHash: expect.stringMatching(/^sha256:/),
        contentHash: expect.stringMatching(/^sha256:/),
      },
    ])
    expect(JSON.stringify(pack)).not.toContain(canary)
    expect(JSON.stringify(pack)).not.toContain('.oph/research')
    store.close()
  })

  test('starts a fresh, locked, evidence-only Session with provider usage accounting', async () => {
    const { root, store, campaign, parent, attemptId, canary } = await fresh()
    const bodies: string[] = []
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push(await request.text())
        return new Response(responseSse('Independent evidence review.'), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const config: OphConfig = {
      active: { provider: 'fake', model: 'fake' },
      mode: 'auto',
      providers: {
        fake: {
          kind: 'openai_responses',
          apiKey: 'fake',
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: { fake: {} },
        },
      },
    }
    try {
      const beforeWorkspace = mostRecentWorkspace(store)!.id
      const first = await runEvidenceReview({
        store,
        config,
        campaignId: campaign.id,
        workspaceRoot: root,
        attemptIds: [attemptId],
        signal: new AbortController().signal,
      })
      const second = await runEvidenceReview({
        store,
        config,
        campaignId: campaign.id,
        workspaceRoot: root,
        attemptIds: [attemptId],
        signal: new AbortController().signal,
        maxOutputChars: 8,
      })
      expect(mostRecentWorkspace(store)!.id).toBe(beforeWorkspace)
      expect(first).toMatchObject({
        status: 'done',
        reviewKind: 'model-review',
        humanApproval: false,
        text: 'Independent evidence review.',
        usage: { inputTokens: 31, outputTokens: 7 },
      })
      expect(second.text).toBe('Independ')
      expect(second.conversationId).not.toBe(first.conversationId)
      expect(getConversation(store, first.conversationId as never)).toMatchObject({
        source: 'workflow',
        parentConversationId: parent.id,
      })
      expect(listRuns(store, first.conversationId as never)).toHaveLength(1)
      expect(usageEntries(store, { conversationId: first.conversationId as never })).toMatchObject([
        { inputTokens: 31, outputTokens: 7 },
      ])
      expect(bodies).toHaveLength(2)
      for (const body of bodies) {
        expect(body).not.toContain(canary)
        expect(body).not.toContain(root)
        expect(body).not.toContain('clinical.txt')
        const sent = JSON.parse(body) as { tools: Array<{ name: string }> }
        expect(sent.tools.map((tool) => tool.name)).toEqual(['read_skill'])
      }
    } finally {
      provider.stop(true)
      store.close()
    }
  })
})
