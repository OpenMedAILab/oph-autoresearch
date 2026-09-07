import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(() => GlobalRegistrator.unregister())
afterEach(() => document.body.replaceChildren())

test('a reusable controller approval displays its signed input and output limits', async () => {
  const { render } = await import('solid-js/web')
  const { ResearchControllerPanel } = await import('./ResearchControllerPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const campaign = {
    id: 'rc-controller',
    workspaceId: 'ws-controller',
    bundleHash: 'sha256:bundle',
    approvals: [
      {
        id: 'approval-controller',
        status: 'active',
        bundleHash: 'sha256:bundle',
        scope: {
          kind: 'controller',
          expiresAt: Date.now() + 60_000,
          controllerLimits: {
            maxAdvances: 2,
            maxModelRequests: 4,
            maxOutputTokens: 2048,
            maxInputCharacters: 8192,
            deadlineAt: Date.now() + 60_000,
            stopAfter: 'candidate',
          },
        },
      },
    ],
  } as Parameters<typeof ResearchControllerPanel>[0]['campaign']
  const dispose = render(
    () => (
      <ResearchControllerPanel
        campaign={campaign}
        approvalUrl="https://approval.example.test"
        busy={false}
        act={async (work) => work()}
      />
    ),
    host,
  )
  const text = host.textContent ?? ''
  expect(text).toContain('正在使用已有审批的实际限额')
  expect(text).toContain('最多输出 2048 tokens，输入最多 8192字符')
  expect(text).not.toContain('输入最多 4096')
  dispose()
})
