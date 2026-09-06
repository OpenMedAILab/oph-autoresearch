import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ResearchCampaign } from '@oph-autoresearch/core'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click', 'input', 'change'], document)
})
afterAll(() => GlobalRegistrator.unregister())
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.body.replaceChildren()
})
const evidence = {
  id: 'evidence-original',
  subject: { kind: 'cli_preparation', id: 'preparation-original' },
  amount: 0.5,
  currency: 'USD',
  description: 'fixture账单',
}
function campaign(approved = false): ResearchCampaign {
  return {
    id: 'campaign-original',
    workspaceId: 'workspace-original',
    version: 12,
    bundleHash: 'bundle-original',
    cliPreparations: [{ id: evidence.subject.id }],
    costEvidence: [evidence],
    costSettlements: [],
    approvals: approved
      ? [
          {
            id: 'approval-original',
            status: 'active',
            consumedBy: null,
            bundleHash: 'bundle-original',
            scope: {
              kind: 'cost_settlement',
              costEvidenceId: evidence.id,
              expiresAt: Date.now() + 60000,
            },
          },
        ]
      : [],
  } as unknown as ResearchCampaign
}
function costs() {
  return {
    summary: {
      currency: 'USD',
      limit: 5,
      committedCost: 1,
      settledCost: 0,
      availableCost: 4,
      overLimit: false,
      subjects: [
        {
          subject: evidence.subject,
          reservation: 1,
          knownActualCost: null,
          settled: false,
          settledAmount: null,
        },
      ],
    },
    evidence: [evidence],
  }
}
async function mount(initial: ResearchCampaign) {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { ResearchCostPanel } = await import('./ResearchCostPanel.tsx')
  const [current, setCurrent] = createSignal(initial)
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  let settled = 0
  const dispose = render(
    () => (
      <ResearchCostPanel
        campaign={current()}
        approvalUrl="http://signer.test"
        busy={false}
        act={async (work) => {
          try {
            await work()
          } catch (error) {
            errors.push(String(error))
          } finally {
            settled++
          }
        }}
      />
    ),
    host,
  )
  cleanups.push(dispose)
  return { host, setCurrent, errors, settled: () => settled }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('UI did not settle')
    await Bun.sleep(5)
  }
}
async function clickSettle(host: HTMLElement) {
  await until(() =>
    Array.from(host.querySelectorAll('button')).some(
      (button) => button.textContent === '独立签署并结算',
    ),
  )
  Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent === '独立签署并结算')!
    .click()
}
test('已签结算丢失响应后可以原样重试，不再报价或开启签署窗口', async () => {
  const { client } = await import('../lib/store/index.ts')
  const posts: Array<{ path: string; body: unknown }> = []
  const api = spyOn(client, 'api').mockImplementation((async (path: string, init?: RequestInit) => {
    if (!init?.method) return costs()
    posts.push({ path, body: JSON.parse(String(init.body)) })
    if (posts.length === 1) throw new Error('response lost')
    return {}
  }) as typeof client.api)
  const popup = spyOn(window, 'open').mockReturnValue(null)
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
  )
  const first = await mount(campaign(true))
  await clickSettle(first.host)
  await until(() => first.settled() === 1)
  expect(first.errors[0]).toContain('response lost')
  const second = await mount(campaign(true))
  await clickSettle(second.host)
  await until(() => second.settled() === 1)
  expect(posts).toHaveLength(2)
  expect(posts[0]).toEqual(posts[1])
  expect(posts[0]).toEqual({
    path: '/api/research/campaigns/campaign-original/costs/settle?ws=workspace-original',
    body: {
      expectedVersion: 12,
      idempotencyKey: 'settle:evidence-original',
      evidenceId: 'evidence-original',
      approvalId: 'approval-original',
    },
  })
  expect(popup).not.toHaveBeenCalled()
  expect(first.host.textContent).toContain('实际费用未知')
})
test('审批期间切换研究项目仍只签署并结算原项目，不向新项目提交', async () => {
  const { client } = await import('../lib/store/index.ts')
  const signer = await import('../lib/research-approval.ts')
  let release!: (value: unknown) => void
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const mutations: string[] = []
  let quoted = false
  const api = spyOn(client, 'api').mockImplementation((async (path: string, init?: RequestInit) => {
    if (path.includes('/costs/quote')) {
      quoted = true
      return pending
    }
    if (!init?.method) return costs()
    mutations.push(path)
    if (path.includes('/approve?')) return { campaign: campaign(true) }
    return {}
  }) as typeof client.api)
  const popup = spyOn(window, 'open').mockImplementation(() => ({ close() {} }) as Window)
  const approve = spyOn(signer, 'requestHumanApproval').mockResolvedValue('fixture-proof')
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
    () => approve.mockRestore(),
  )
  const ui = await mount(campaign())
  await clickSettle(ui.host)
  await until(() => quoted)
  ui.setCurrent({ ...campaign(), id: 'campaign-new', workspaceId: 'workspace-new' })
  release({
    body: { expectedVersion: 12, scope: { kind: 'cost_settlement', costEvidenceId: evidence.id } },
  })
  await until(() => ui.settled() === 1)
  expect(ui.errors).toHaveLength(0)
  expect(mutations).toHaveLength(2)
  expect(
    mutations.every(
      (path) => path.includes('/campaign-original/') && path.includes('ws=workspace-original'),
    ),
  ).toBe(true)
  expect(approve.mock.calls[0]![1]).toMatchObject({
    campaignId: 'campaign-original',
    workspaceId: 'workspace-original',
  })
})
test('费用读取失败不会渲染成零费用，也没有可用结算入口', async () => {
  const { client } = await import('../lib/store/index.ts')
  const api = spyOn(client, 'api').mockRejectedValue(new Error('unavailable'))
  cleanups.push(() => api.mockRestore())
  const ui = await mount(campaign())
  await until(() => ui.host.textContent?.includes('费用记录暂不可读取') ?? false)
  expect(ui.host.textContent).not.toContain('已结算 0')
  expect(
    Array.from(ui.host.querySelectorAll('button')).some(
      (button) => button.textContent === '独立签署并结算',
    ),
  ).toBe(false)
})
