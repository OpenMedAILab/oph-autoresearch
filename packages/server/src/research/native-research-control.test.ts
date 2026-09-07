import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConversation,
  createResearchCampaign,
  Store,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import type { ApiRequestDeps } from '../api/types.ts'
import { EventBus } from '../bus.ts'
import {
  createNativeResearchControlBridge,
  createResearchControlPort,
} from './native-research-control.ts'

test('native CLI receives only a scoped bridge and cannot approve or cross campaigns', async () => {
  const store = new Store({ path: ':memory:' })
  const abort = new AbortController()
  const root = await mkdtemp(join(tmpdir(), 'oph-native-control-'))
  try {
    const workspace = upsertWorkspace(store, root, 'native control')
    const parent = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'cli:codex',
      model: 'default',
    })
    const campaign = createResearchCampaign(store, {
      workspaceId: workspace.id,
      parentConversationId: parent.id,
      goal: 'fixed local fixture',
      policy: {},
      inputs: {},
      budget: { currency: 'USD', limit: 0 },
      idempotencyKey: 'campaign',
    })
    if (!campaign.ok) throw new Error(campaign.message)
    const bridge = createNativeResearchControlBridge(
      {
        store,
        workspaceId: workspace.id,
        workspaceRoot: root,
        bus: new EventBus(),
      } as unknown as ApiRequestDeps,
      [campaign.campaign.id],
      abort.signal,
    )
    try {
      const clientEntry = join(import.meta.dir, '../../../cli/src/research-control.ts')
      const code = `
const client = await import(process.env.OPH_RESEARCH_CONTROL_CLIENT_ENTRY)
const call = (operation, campaign) => client.runResearchControl([operation, '--campaign', campaign])
console.log(JSON.stringify([await call('status', process.env.CAMPAIGN), await call('documents/read', process.env.CAMPAIGN), await call('approve', process.env.CAMPAIGN), await call('status', 'another-campaign')]))
`
      const child = Bun.spawn([process.execPath, '--eval', code], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          OPH_RESEARCH_CONTROL_ENDPOINT: bridge.endpoint,
          OPH_RESEARCH_CONTROL_TOKEN: bridge.token,
          OPH_RESEARCH_CONTROL_CAMPAIGNS: campaign.campaign.id,
          OPH_RESEARCH_CONTROL_CLIENT_ENTRY: clientEntry,
          CAMPAIGN: campaign.campaign.id,
        },
      })
      expect(await new Response(child.stdout).text()).toContain('[0,0,2,2]')
      expect(await child.exited).toBe(0)
    } finally {
      bridge.close()
    }
    const expired = createNativeResearchControlBridge(
      {
        store,
        workspaceId: workspace.id,
        workspaceRoot: root,
        bus: new EventBus(),
      } as unknown as ApiRequestDeps,
      [campaign.campaign.id],
      abort.signal,
      Date.now() - 1,
    )
    try {
      const response = await fetch(`${expired.endpoint}/api/research/control`, {
        method: 'POST',
        headers: { authorization: `Bearer ${expired.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'status', campaignId: campaign.campaign.id }),
      })
      expect(response.status).toBe(410)
    } finally {
      expired.close()
    }
  } finally {
    abort.abort()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native bridge and API port share selection, list, and immutable allowlist semantics', async () => {
  const store = new Store({ path: ':memory:' })
  const abort = new AbortController()
  const root = await mkdtemp(join(tmpdir(), 'oph-native-control-parity-'))
  try {
    const workspace = upsertWorkspace(store, root, 'native parity')
    const otherWorkspace = upsertWorkspace(store, `${root}-other`, 'other workspace')
    const conversation = createConversation(store, {
      workspaceId: workspace.id,
      provider: 'cli:codex',
      model: 'default',
    })
    const otherConversation = createConversation(store, {
      workspaceId: otherWorkspace.id,
      provider: 'cli:codex',
      model: 'default',
    })
    const create = (workspaceId: string, parentConversationId: string, key: string) =>
      createResearchCampaign(store, {
        workspaceId,
        parentConversationId,
        goal: key,
        policy: {},
        inputs: {},
        budget: { currency: 'USD', limit: 0 },
        idempotencyKey: key,
      })
    const first = create(workspace.id, conversation.id, 'first')
    const second = create(workspace.id, conversation.id, 'second')
    const foreign = create(otherWorkspace.id, otherConversation.id, 'foreign')
    if (!first.ok || !second.ok || !foreign.ok) throw new Error('campaign fixture failed')
    const deps = {
      store,
      workspaceId: workspace.id,
      workspaceRoot: root,
      bus: new EventBus(),
    } as unknown as ApiRequestDeps
    const port = createResearchControlPort(deps, [
      first.campaign.id,
      second.campaign.id,
      foreign.campaign.id,
    ])
    const bridge = createNativeResearchControlBridge(
      deps,
      [first.campaign.id, second.campaign.id, foreign.campaign.id],
      abort.signal,
    )
    const native = async (body: Record<string, unknown>) => {
      const response = await fetch(`${bridge.endpoint}/api/research/control`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, data: await response.json() }
    }
    try {
      const apiList = await port.execute({ operation: 'list', campaignId: '' })
      const nativeList = await native({ operation: 'list' })
      expect(nativeList.status).toBe(apiList.status)
      expect(nativeList.data).toEqual(apiList.data)
      expect(
        (nativeList.data as { campaigns: { campaignId: string }[] }).campaigns
          .map((c) => c.campaignId)
          .sort(),
      ).toEqual([first.campaign.id, second.campaign.id].sort())

      // Several eligible campaigns never pick one implicitly; cross-workspace IDs are not discoverable.
      expect((await port.execute({ operation: 'status', campaignId: '' })).status).toBe(409)
      expect((await native({ operation: 'status' })).status).toBe(409)
      expect(
        (await port.execute({ operation: 'status', campaignId: foreign.campaign.id })).status,
      ).toBe(403)
      expect((await native({ operation: 'status', campaignId: foreign.campaign.id })).status).toBe(
        403,
      )
      expect((await native({ operation: 'approve', campaignId: first.campaign.id })).status).toBe(
        400,
      )

      const singleton = createResearchControlPort(deps, [first.campaign.id])
      const none = createResearchControlPort(deps, [])
      expect((await singleton.execute({ operation: 'status', campaignId: '' })).status).toBe(200)
      expect((await none.execute({ operation: 'status', campaignId: '' })).data).toMatchObject({
        error: 'campaign_unavailable',
      })
    } finally {
      bridge.close()
    }
  } finally {
    abort.abort()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
