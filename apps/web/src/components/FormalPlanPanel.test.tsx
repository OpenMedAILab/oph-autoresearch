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
const hash = (char: string) => `sha256:${char.repeat(64)}`
const plan = {
  planId: 'private-plan',
  candidateArtifactId: 'private-artifact',
  ociImageDigest: hash('a'),
  dataManifestHash: hash('b'),
  labelSetContentHash: hash('c'),
  trustedEvaluatorId: 'binary-classification-v1',
  trustedEvaluatorHash: hash('d'),
  resources: { maxRuntimeMs: 1800000, cpu: 2, memoryMb: 1024, pidsLimit: 64, network: 'disabled' },
}
function campaign(): ResearchCampaign {
  return {
    id: 'campaign-original',
    workspaceId: 'workspace-original',
    version: 9,
    bundleHash: hash('e'),
    budget: { currency: 'USD', limit: 100 },
    approvals: [],
    cliPreparations: [{ id: 'private-preparation', status: 'candidate' }],
  } as unknown as ResearchCampaign
}
function state() {
  return {
    plans: [] as unknown[],
    reviews: [
      {
        formalPlanHash: hash('f'),
        decision: 'accepted',
        findings: [{ message: '代码复核通过。' }],
      },
    ],
    drafts: [{ plan, preparationId: 'private-preparation', dispatchId: 'private-dispatch' }],
    dispatches: [{ id: 'private-dispatch', formalPlanHash: hash('f'), status: 'done' }],
    admittedBackend: false,
    admissionReason: '服务器尚未通过容器隔离验收',
    catalog: {
      images: [{ label: 'Python 科研镜像', digest: hash('a') }],
      datasets: [
        { label: '合成验收数据', dataManifestHash: hash('b'), labelSetContentHash: hash('c') },
      ],
      evaluators: [
        { id: 'binary-classification-v1', label: '二分类评估', implementationHash: hash('d') },
      ],
    },
  }
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}
async function mount() {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { FormalPlanPanel } = await import('./FormalPlanPanel.tsx')
  const [current, setCurrent] = createSignal(campaign())
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  let finished = 0
  cleanups.push(
    render(
      () => (
        <FormalPlanPanel
          campaign={current()}
          approvalUrl="http://signer.test"
          busy={false}
          act={async (work) => {
            try {
              await work()
            } catch (error) {
              errors.push(String(error))
            } finally {
              finished++
            }
          }}
        />
      ),
      host,
    ),
  )
  return { host, setCurrent, errors, finished: () => finished }
}
const button = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll('button')).find((item) => item.textContent === text)!
async function selectNewPlan(host: HTMLElement) {
  await until(() => host.querySelectorAll('select').length === 4)
  for (const select of host.querySelectorAll('select')) {
    select.selectedIndex = 1
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
}
async function mocks(handler: (path: string, init?: RequestInit) => unknown) {
  const { client } = await import('../lib/store/index.ts')
  const signer = await import('../lib/research-approval.ts')
  const api = spyOn(client, 'api').mockImplementation(handler as typeof client.api)
  const popup = spyOn(window, 'open').mockImplementation(() => ({ close() {} }) as Window)
  const approve = spyOn(signer, 'requestHumanApproval').mockResolvedValue('fixture-proof')
  cleanups.push(
    () => api.mockRestore(),
    () => popup.mockRestore(),
    () => approve.mockRestore(),
  )
  return { api, popup, approve }
}

test('未准入环境禁用正式执行，显示名称与序号而不显示内部标识', async () => {
  await mocks(async () => ({ ...state(), plans: [plan] }))
  const ui = await mount()
  await until(() => Boolean(button(ui.host, '提交正式实验')))
  expect(button(ui.host, '提交正式实验').disabled).toBe(true)
  expect(ui.host.textContent).toContain('服务器尚未通过容器隔离验收')
  expect(ui.host.textContent).toContain('Python 科研镜像')
  expect(ui.host.textContent).not.toContain('sha256:')
  expect(ui.host.textContent).not.toContain('private-')
})

test('刷新后用服务端保存的完整草案批准冻结，不重发模型且不带额外网络字段', async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  await mocks(async (path, init) => {
    if (!init?.method)
      return path.includes('/formal-execution?') ? state() : { campaign: campaign() }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    posts.push({ path, body })
    if (path.includes('/formal-execution/approval?'))
      return { formalExecutionApprovalScope: { kind: 'formal_execution' } }
    if (path.includes('/approve?')) return { campaign: { ...campaign(), version: 10 } }
    return {}
  })
  const ui = await mount()
  await until(() => Boolean(button(ui.host, '独立批准并冻结计划')))
  button(ui.host, '独立批准并冻结计划').click()
  await until(() => ui.finished() === 1)
  expect(ui.errors).toHaveLength(0)
  expect(posts).toHaveLength(3)
  const frozen = posts[2]!
  expect(frozen.path).toContain('/formal-execution/freeze?ws=workspace-original')
  expect(frozen.body).toMatchObject({
    planId: plan.planId,
    preparationId: 'private-preparation',
    ociImageDigest: plan.ociImageDigest,
    dataManifestHash: plan.dataManifestHash,
    maxRuntimeMs: 1800000,
    cpu: 2,
    memoryMb: 1024,
    pidsLimit: 64,
    expectedVersion: 10,
  })
  expect(frozen.body.network).toBeUndefined()
  expect(posts.some((post) => post.path.includes('/review?'))).toBe(false)
})

test('审阅丢失响应后原样重试同一请求，不重复报价或签署', async () => {
  const reviews: unknown[] = []
  let quotes = 0
  const mocked = await mocks(async (path, init) => {
    if (!init?.method)
      return path.includes('/formal-execution?')
        ? { ...state(), drafts: [] }
        : { campaign: campaign() }
    if (path.includes('/quote?')) {
      quotes++
      return { reviewApprovalScope: { kind: 'formal_code_review' } }
    }
    if (path.includes('/approve?')) return { campaign: { ...campaign(), version: 10 } }
    if (path.includes('/review?')) {
      reviews.push(JSON.parse(String(init.body)))
      if (reviews.length === 1) throw new Error('response lost')
      return { replayed: true }
    }
    throw new Error(`unexpected route ${path}`)
  })
  const ui = await mount()
  await selectNewPlan(ui.host)
  button(ui.host, '独立批准并审阅候选代码').click()
  await until(() => ui.finished() === 1)
  expect(ui.errors[0]).toContain('response lost')
  button(ui.host, '查询或继续上次操作').click()
  await until(() => ui.finished() === 2)
  expect(reviews).toHaveLength(2)
  expect(reviews[1]).toEqual(reviews[0])
  expect(quotes).toBe(1)
  expect(mocked.approve).toHaveBeenCalledTimes(1)
  expect(mocked.popup).toHaveBeenCalledTimes(1)
})

test('审批期间切换项目仍仅向原项目提交，并清除旧草案视图', async () => {
  let release!: (value: unknown) => void
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  let quoting = false
  const posts: string[] = []
  const mocked = await mocks(async (path, init) => {
    if (!init?.method)
      return path.includes('/formal-execution?')
        ? path.includes('campaign-new')
          ? {
              ...state(),
              drafts: [],
              plans: [],
              reviews: [],
              catalog: { images: [], datasets: [], evaluators: [] },
            }
          : state()
        : { campaign: campaign() }
    posts.push(path)
    if (path.includes('/quote?')) {
      quoting = true
      return waiting
    }
    if (path.includes('/approve?')) return { campaign: { ...campaign(), version: 10 } }
    return {}
  })
  const ui = await mount()
  await selectNewPlan(ui.host)
  button(ui.host, '独立批准并审阅候选代码').click()
  await until(() => quoting)
  ui.setCurrent({
    ...campaign(),
    id: 'campaign-new',
    workspaceId: 'workspace-new',
    cliPreparations: [],
  })
  release({ reviewApprovalScope: { kind: 'formal_code_review' } })
  await until(() => ui.finished() === 1)
  expect(ui.errors).toHaveLength(0)
  expect(
    posts.every(
      (path) => path.includes('campaign-original') && path.includes('ws=workspace-original'),
    ),
  ).toBe(true)
  expect(mocked.approve.mock.calls[0]![1]).toMatchObject({
    campaignId: 'campaign-original',
    workspaceId: 'workspace-original',
  })
  expect(ui.host.textContent).not.toContain('实验草案 1')
  expect(ui.host.textContent).not.toContain('查询或继续上次操作')
})

test('状态读取失败不会显示可用的正式运行入口', async () => {
  await mocks(async () => {
    throw new Error('unavailable')
  })
  const ui = await mount()
  await until(() => ui.host.textContent?.includes('正式实验状态加载失败') ?? false)
  expect(button(ui.host, '提交正式实验')).toBeUndefined()
})

test('未知正式执行只核对原任务，取消请求不会被显示成已经停止', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  await mocks(async (path, init) => {
    if (init?.method) {
      calls.push({ path, body: JSON.parse(String(init.body)) })
      return {}
    }
    return {
      ...state(),
      plans: [plan],
      admittedBackend: true,
      executions: [
        {
          id: 'private-execution',
          planId: plan.planId,
          attemptId: 'private-attempt',
          status: 'unknown',
        },
      ],
    }
  })
  const ui = await mount()
  ui.setCurrent({
    ...campaign(),
    attempts: [{ id: 'private-attempt', status: 'unknown', cancelRequestedAt: null } as never],
  })
  await until(() => Boolean(button(ui.host, '核对正式执行状态')))
  expect(button(ui.host, '提交正式实验')).toBeUndefined()
  expect(ui.host.textContent).toContain('状态待核对，不会重新投递')
  button(ui.host, '核对正式执行状态').click()
  await until(() => ui.finished() === 1)
  button(ui.host, '请求取消正式执行').click()
  await until(() => ui.finished() === 2)
  expect(calls).toEqual([
    {
      path: '/api/research/campaigns/campaign-original/formal-execution/reconcile?ws=workspace-original',
      body: { attemptId: 'private-attempt' },
    },
    {
      path: '/api/research/campaigns/campaign-original/formal-execution/cancel?ws=workspace-original',
      body: { attemptId: 'private-attempt' },
    },
  ])
  ui.setCurrent({
    ...campaign(),
    version: 10,
    attempts: [
      { id: 'private-attempt', status: 'unknown', cancelRequestedAt: Date.now() } as never,
    ],
  })
  await until(() => ui.host.textContent?.includes('已请求取消，等待确认实际停止') ?? false)
  expect(button(ui.host, '请求取消正式执行').disabled).toBe(true)
  expect(ui.host.textContent).not.toContain('已确认取消')
  expect(ui.host.textContent).not.toContain('private-attempt')
})

test('执行完成须匹配归档回执才显示已核验，隔离结果不能冒充正式成果', async () => {
  await mocks(async () => ({
    ...state(),
    plans: [plan],
    executions: [
      {
        id: 'private-execution',
        planId: plan.planId,
        attemptId: 'private-attempt',
        status: 'completed',
        receiptHash: hash('a'),
      },
    ],
  }))
  const ui = await mount()
  const completed: ResearchCampaign = {
    ...campaign(),
    attempts: [
      {
        id: 'private-attempt',
        status: 'completed',
        artifactVersionId: 'receipt',
        cancelRequestedAt: null,
      } as never,
    ],
    artifactVersions: [],
  }
  ui.setCurrent(completed)
  await until(() => ui.host.textContent?.includes('执行回执尚未核验') ?? false)
  expect(ui.host.textContent).not.toContain('执行回执已核验并归档')
  ui.setCurrent({
    ...completed,
    artifactVersions: [
      {
        id: 'receipt',
        producerAttemptId: 'private-attempt',
        kind: 'formal_execution_receipt',
        schemaId: 'research-formal-oci-receipt-v1',
        contentHash: hash('a'),
      } as never,
    ],
  })
  await until(() => ui.host.textContent?.includes('执行回执已核验并归档') ?? false)
  ui.setCurrent({
    ...completed,
    attempts: [{ ...completed.attempts[0]!, resultDisposition: 'quarantined' }],
  })
  await until(() => ui.host.textContent?.includes('迟到结果已隔离，不能作为正式成果') ?? false)
  expect(ui.host.textContent).not.toContain('执行回执已核验并归档')
})
