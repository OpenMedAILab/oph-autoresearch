import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // Earlier suites can import this component under a different Happy DOM document.
  // Rebind Solid's delegated listener to this suite's new document, like a fresh browser load.
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'], document)
})
afterAll(() => GlobalRegistrator.unregister())
let dispose: (() => void) | undefined
let restore: (() => void) | undefined
test('persisted cancellation remains visible after remount and cannot be requested twice', async () => {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws-cancel', root: 'D:/synthetic', name: 'synthetic' })
  store.setState('activeConversation', 'cv-cancel')
  const mocked = spyOn(store.client, 'api').mockResolvedValue({
    notifications: [],
    documents: [],
    campaigns: [
      {
        id: 'rc-cancel',
        goal: 'cancel test',
        stage: 'execution',
        status: 'running',
        version: 3,
        artifactVersions: [],
        approvals: [],
        taskRevisions: [],
        attempts: [{ id: 'rat-cancel', status: 'running', cancelRequestedAt: 123, error: null }],
      },
    ],
  })
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchCampaignPanel } = await import('./ResearchCampaignPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ResearchCampaignPanel />, host)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain('取消请求中，等待执行者确认')
  expect(
    Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '请求取消'),
  ).toBe(false)
})
afterEach(async () => {
  dispose?.()
  restore?.()
  document.body.replaceChildren()
  const store = await import('../lib/store/index.ts')
  store.setWorkspace(null)
  store.setState('activeConversation', null)
})

test('research panel saves a proposal and renders ledger facts without an approval button', async () => {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws-test', root: 'D:/synthetic', name: 'synthetic' })
  store.setState('activeConversation', 'cv-test')
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
  let saved = false
  const mocked = spyOn(store.client, 'api').mockImplementation((async (
    path: string,
    init?: RequestInit,
  ) => {
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (init?.method === 'POST') {
      saved = true
      return { ok: true }
    }
    return {
      notifications: [],
      documents: [],
      campaigns: saved
        ? [
            {
              id: 'rc-test',
              goal: '合成数据研究',
              stage: 'question',
              status: 'proposal',
              version: 1,
              artifactVersions: [],
              approvals: [],
            },
          ]
        : [],
    }
  }) as typeof store.client.api)
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchCampaignPanel } = await import('./ResearchCampaignPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ResearchCampaignPanel />, host as unknown as HTMLElement)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const input = host.querySelector('input')!
  input.value = '合成数据研究'
  // Solid's module-level delegated document can predate this test's happy-dom document.
  const delegated = (
    input as unknown as { $$input?: (event: { currentTarget: typeof input }) => void }
  ).$$input
  if (delegated) delegated.call(input, { currentTarget: input })
  else input.dispatchEvent(new Event('input', { bubbles: true }))
  host
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests.find((request) => request.body)?.body).toMatchObject({
    goal: '合成数据研究',
    parentConversationId: 'cv-test',
  })
  expect(host.textContent).toContain('提案已保存')
  expect(host.textContent).toContain('未批准提案')
  expect(host.textContent).toContain('尚未配置独立审批渠道')
  expect(
    Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '批准'),
  ).toBe(false)
})

test('a completed request cannot put its feedback or campaign into a newly selected conversation', async () => {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws-scope', root: 'D:/synthetic', name: 'synthetic' })
  store.setState('activeConversation', 'old-parent')
  let finish: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const mocked = spyOn(store.client, 'api').mockImplementation((async (
    _path: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') {
      await held
      return { ok: true }
    }
    return { campaigns: [] }
  }) as typeof store.client.api)
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchCampaignPanel } = await import('./ResearchCampaignPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ResearchCampaignPanel />, host as unknown as HTMLElement)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const input = host.querySelector('input')!
  input.value = 'Old conversation goal'
  const delegated = (
    input as unknown as { $$input?: (event: { currentTarget: typeof input }) => void }
  ).$$input
  if (delegated) delegated.call(input, { currentTarget: input })
  else input.dispatchEvent(new Event('input', { bubbles: true }))
  host
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  store.setState('activeConversation', 'new-parent')
  finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).not.toContain('研究提案已保存')
  expect(host.querySelector('input')!.value).toBe('')
  expect(host.querySelector('input')!.disabled).toBe(false)
})

test('lost synthetic response keeps its dispatch key after a notification advances the version', async () => {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws-retry', root: 'D:/synthetic', name: 'synthetic' })
  store.setState('activeConversation', 'parent-retry')
  let version = 1
  const dispatches: Array<{ dispatchKey: string; expectedVersion: number }> = []
  const campaignId = crypto.randomUUID()
  const mocked = spyOn(store.client, 'api').mockImplementation((async (
    _path: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') {
      dispatches.push(JSON.parse(String(init.body)))
      if (dispatches.length === 1) {
        version = 3
        store.applyEvent({
          seq: 1,
          at: Date.now(),
          conversationId: 'parent-retry' as never,
          event: {
            type: 'research.changed',
            eventId: 'done',
            campaignId,
            campaignSeq: 3,
            workspaceId: 'ws-retry',
            parentConversationId: 'parent-retry',
          },
        })
        throw new Error('response lost after completion')
      }
      return { ok: true }
    }
    return {
      notifications: [],
      documents: [],
      campaigns: [
        {
          id: campaignId,
          workspaceId: 'ws-retry',
          goal: 'synthetic',
          stage: 'question',
          status: 'proposal',
          version,
          artifactVersions: [],
          approvals: [],
          attempts: [],
        },
      ],
    }
  }) as typeof store.client.api)
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchCampaignPanel } = await import('./ResearchCampaignPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ResearchCampaignPanel />, host as unknown as HTMLElement)
  const clickRun = () => {
    const button = Array.from(host.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('运行：摘要检查'),
    )!
    const event = new MouseEvent('click', { bubbles: true })
    const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
    if (delegated) delegated.call(button, event)
    else button.dispatchEvent(event)
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  clickRun()
  await new Promise((resolve) => setTimeout(resolve, 0))
  clickRun()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(dispatches).toHaveLength(2)
  expect(dispatches[1]?.dispatchKey).toBe(dispatches[0]?.dispatchKey)
  expect(dispatches[1]?.expectedVersion).toBe(3)
})

test('fixed template choices and unknown-state reconciliation use explicit API payloads', async () => {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws-template', root: 'D:/synthetic', name: 'synthetic' })
  store.setState('activeConversation', 'cv-template')
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const mocked = spyOn(store.client, 'api').mockImplementation((async (
    path: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') {
      requests.push({ path, body: JSON.parse(String(init.body)) })
      return { ok: true }
    }
    return {
      notifications: [],
      documents: [],
      campaigns: [
        {
          id: 'rc-template',
          modelReviews: [
            {
              id: 'rmr-stale',
              artifactVersionIds: ['rav-1'],
              status: 'done',
              sourceValidity: 'stale',
              requestCount: 1,
              maxRequests: 2,
              actualCost: null,
              reservedCost: 1,
              currency: 'USD',
              text: 'historical model finding',
            },
          ],
          workspaceId: 'ws-template',
          goal: 'fixed',
          stage: 'execution',
          status: 'active',
          version: 2,
          artifactVersions: [
            {
              id: 'rav-1',
              kind: 'synthetic-summary-v1',
              schemaId: 'synthetic-summary-v1',
              dataClass: 'synthetic',
              contentHash: 'sha256:x',
              createdAt: 1,
              validation: {
                inputHash: 'sha256:i',
                contentHash: 'sha256:c',
                byteLength: 2,
                verifiedAt: 1,
              },
            },
          ],
          approvals: [],
          taskRevisions: [
            {
              id: 'rtr-1',
              revision: 1,
              stage: 'execution',
              stageId: 'evaluation',
              templateId: 'synthetic-evaluation-v1',
              inputHash: 'sha256:i',
              outputContract: 'synthetic-evaluation-v1',
              dataClass: 'synthetic',
              status: 'verified',
              createdAt: 1,
            },
          ],
          attempts: [
            {
              id: 'rat-unknown',
              taskRevisionId: 'rtr-1',
              dispatchKey: 'dispatch',
              ownerPid: 1,
              status: 'unknown',
              executionStartedAt: 1,
              endedAt: null,
              artifactVersionId: null,
              error: null,
              cancelRequestedAt: null,
              backend: 'localhost-daemon',
            },
          ],
        },
      ],
    }
  }) as typeof store.client.api)
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchCampaignPanel } = await import('./ResearchCampaignPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ResearchCampaignPanel />, host as HTMLElement)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain('评估 → 远程实验')
  expect(host.textContent).not.toContain('schema synthetic-summary-v1')
  expect(host.textContent).not.toContain('rtr-1')
  expect(host.textContent).not.toContain('rat-unknown')
  expect(host.textContent).not.toContain('sha256:')
  expect(host.textContent).toContain('状态未知，等待核对')
  expect(host.textContent).toContain('合成眼底图像实验')
  expect(host.textContent).toContain('公开文献元数据')
  expect(host.textContent).toContain('标注数据汇总')
  expect(host.textContent).toContain('证据已失效，仅供历史查看')
  const training = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('合成特征评估'),
  )!
  training.click()
  const reconcile = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === '核对状态',
  )!
  reconcile.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining('/synthetic?'),
        body: expect.objectContaining({ templateId: 'synthetic-training-evaluation-v1' }),
      }),
      expect.objectContaining({
        path: expect.stringContaining('/synthetic/reconcile?'),
        body: { attemptId: 'rat-unknown' },
      }),
    ]),
  )
})

test('notification delivery refreshes without a research ledger version change', async () => {
  const store = await import('../lib/store/index.ts')
  let delivered = false
  const mocked = spyOn(store.client, 'api').mockImplementation((async () => ({
    notifications: [
      {
        eventId: 'hidden-event-id',
        kind: 'completed',
        channel: 'test',
        status: delivered ? 'delivered' : 'pending',
        attempts: delivered ? 1 : 0,
        createdAt: 1,
      },
    ],
  })) as typeof store.client.api)
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchNotificationsPanel } = await import('./ResearchNotificationsPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(
    () => <ResearchNotificationsPanel campaignId="research" workspaceId="workspace" version={1} />,
    host,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain('等待投递')
  delivered = true
  host.querySelector('button')!.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain('已确认送达')
  expect(host.textContent).not.toContain('hidden-event-id')
})

test('malformed notification payload reports an error without crashing the research panel', async () => {
  const store = await import('../lib/store/index.ts')
  const mocked = spyOn(store.client, 'api').mockResolvedValue({})
  restore = () => mocked.mockRestore()
  const { render } = await import('solid-js/web')
  const { ResearchNotificationsPanel } = await import('./ResearchNotificationsPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(
    () => <ResearchNotificationsPanel campaignId="research" workspaceId="workspace" version={1} />,
    host,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain('投递记录暂时无法读取')
})
