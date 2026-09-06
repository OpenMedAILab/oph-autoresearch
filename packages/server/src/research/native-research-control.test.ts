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
import { createNativeResearchControlBridge } from './native-research-control.ts'

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
