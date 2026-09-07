import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ResearchCampaign } from '@oph-autoresearch/core'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'], document)
})
afterAll(() => GlobalRegistrator.unregister())
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.body.replaceChildren()
})

function campaign(approved = false, id = 'campaign-original'): ResearchCampaign {
  return {
    id,
    workspaceId: 'workspace-original',
    version: 12,
    bundleHash: 'frozen-bundle',
    budget: { currency: 'USD', limit: 5 },
    taskRevisions: [],
    attempts: [],
    cliPreparations: [
      {
        id: 'preparation-original',
        dispatchKey: 'dispatch-original',
        status: 'proposed',
        maxCost: 1,
      },
    ],
    approvals: approved
      ? [
          {
            id: 'approval-original',
            status: 'active',
            consumedBy: null,
            bundleHash: 'frozen-bundle',
            scope: {
              kind: 'cli_preparation',
              dispatchKey: 'dispatch-original',
              expiresAt: Date.now() + 60000,
            },
          },
        ]
      : [],
  } as unknown as ResearchCampaign
}

async function mount(initial: ResearchCampaign) {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { ResearchCliPreparationPanel } = await import('./ResearchCliPreparationPanel.tsx')
  const [current, setCurrent] = createSignal(initial)
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  let settled = 0
  const dispose = render(
    () => (
      <ResearchCliPreparationPanel
        campaign={current()}
        approvalUrl="http://signer.test/approve"
        busy={false}
        taskName={() => '研究任务'}
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
  return { host, errors, setCurrent, settled: () => settled }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('UI operation did not settle')
    await Bun.sleep(5)
  }
}
function click(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  )
  if (!button) throw new Error(`Missing button: ${label}`)
  button.click()
}

test('remount resumes a signed preparation without a new proposal, quote or popup', async () => {
  const { client } = await import('../lib/store/index.ts')
  const posts: Array<{ path: string; body: unknown }> = []
  const api = spyOn(client, 'api').mockImplementation((async (path: string, init?: RequestInit) => {
    if (path.includes('/catalog')) return { routes: [] }
    posts.push({ path, body: JSON.parse(String(init?.body)) })
    if (posts.length === 1) throw new Error('submit response lost')
    return { replayed: true }
  }) as typeof client.api)
  const popup = spyOn(window, 'open').mockReturnValue(null)
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
  )
  const first = await mount(campaign(true))
  click(first.host, '提交已审批的代码准备')
  await until(() => first.settled() === 1)
  expect(first.errors[0]).toContain('submit response lost')
  const remounted = await mount(campaign(true))
  click(remounted.host, '提交已审批的代码准备')
  await until(() => remounted.settled() === 1)
  expect(posts).toHaveLength(2)
  expect(posts[0]).toEqual(posts[1])
  expect(posts[1]).toEqual({
    path: '/api/research/campaigns/campaign-original/cli-preparations/submit?ws=workspace-original',
    body: {
      preparationId: 'preparation-original',
      approvalId: 'approval-original',
      expectedVersion: 12,
    },
  })
  expect(popup).not.toHaveBeenCalled()
})

test('closing approval can resume the same proposal with a fresh unchanged signed body', async () => {
  const { client } = await import('../lib/store/index.ts')
  const signer = await import('../lib/research-approval.ts')
  const requests: Array<{ path: string; init: RequestInit | undefined }> = []
  const bodies: unknown[] = []
  const api = spyOn(client, 'api').mockImplementation((async (path: string, init?: RequestInit) => {
    if (path.includes('/catalog')) return { routes: [] }
    requests.push({ path, init })
    if (path.includes('/approval?')) {
      const body = {
        expectedVersion: 12,
        idempotencyKey: `fresh-${bodies.length}`,
        scope: { dispatchKey: 'dispatch-original', expiresAt: Date.now() + 60000 },
      }
      bodies.push(body)
      return { body }
    }
    if (path.includes('/approve?')) return { campaign: campaign(true) }
    return { replayed: false }
  }) as typeof client.api)
  const popup = spyOn(window, 'open').mockImplementation(() => ({ close() {} }) as Window)
  const approve = spyOn(signer, 'requestHumanApproval')
    .mockRejectedValueOnce(new Error('审批窗口已关闭'))
    .mockResolvedValueOnce('fixture-bound-proof')
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
    () => approve.mockRestore(),
  )
  const ui = await mount(campaign())
  click(ui.host, '继续本次准备审批')
  await until(() => ui.settled() === 1)
  expect(ui.errors[0]).toContain('审批窗口已关闭')
  click(ui.host, '继续本次准备审批')
  await until(() => ui.settled() === 2)
  const quotes = requests.filter((request) => request.path.includes('/approval?'))
  expect(quotes).toHaveLength(2)
  expect(quotes[0]!.path).toBe(quotes[1]!.path)
  expect(quotes[0]!.path).toContain('preparationId=preparation-original')
  expect(requests.some((request) => request.path.includes('/propose'))).toBe(false)
  const signed = requests.find((request) => request.path.includes('/approve?'))!
  expect(JSON.parse(String(signed.init?.body))).toEqual(bodies[1])
  expect(approve.mock.calls[1]![1].body).toBe(bodies[1])
  expect(new Headers(signed.init?.headers).get('x-oph-human-proof')).toBe('fixture-bound-proof')
  expect(JSON.parse(String(requests.at(-1)?.init?.body)).preparationId).toBe('preparation-original')
})

test('switching campaign during approval does not submit into the new campaign scope', async () => {
  const { client } = await import('../lib/store/index.ts')
  const signer = await import('../lib/research-approval.ts')
  let release!: (value: unknown) => void
  const deferred = new Promise((resolve) => {
    release = resolve
  })
  const requests: string[] = []
  const api = spyOn(client, 'api').mockImplementation((async (path: string) => {
    if (path.includes('/catalog')) return { routes: [] }
    requests.push(path)
    if (path.includes('/approval?')) return deferred
    if (path.includes('/approve?')) return { campaign: campaign(true) }
    return {}
  }) as typeof client.api)
  const popup = spyOn(window, 'open').mockImplementation(() => ({ close() {} }) as Window)
  const approve = spyOn(signer, 'requestHumanApproval').mockResolvedValue('fixture-bound-proof')
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
    () => approve.mockRestore(),
  )
  const ui = await mount(campaign())
  click(ui.host, '继续本次准备审批')
  await until(() => requests.length === 1)
  ui.setCurrent({ ...campaign(false, 'campaign-new'), workspaceId: 'workspace-new' })
  release({ body: { expectedVersion: 12, scope: { dispatchKey: 'dispatch-original' } } })
  await until(() => ui.settled() === 1)
  expect(requests).toHaveLength(3)
  expect(
    requests.every(
      (path) => path.includes('/campaign-original/') && path.includes('ws=workspace-original'),
    ),
  ).toBe(true)
  expect(approve.mock.calls[0]![1]).toMatchObject({
    campaignId: 'campaign-original',
    workspaceId: 'workspace-original',
  })
})
