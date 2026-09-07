import { getResearchCampaign } from '@oph-autoresearch/store'
import { readCliCandidateView } from '../research/cli-candidate-view.ts'
import { CliPreparationControlError } from '../research/cli-preparation-controller.ts'
import { type ApiHandler, json } from './types.ts'

export const handleCliPreparationsApi: ApiHandler = async (url, request, deps) => {
  const match =
    /^\/api\/research\/campaigns\/([A-Za-z0-9_-]+)\/cli-preparations(?:\/(catalog|propose|approval|submit|reconcile|cancel|candidate))?$/.exec(
      url.pathname,
    )
  if (!match) return null
  const campaignId = match[1]!
  const campaign = getResearchCampaign(deps.store, campaignId)
  if (!campaign || campaign.workspaceId !== deps.workspaceId)
    return json({ error: 'not_found' }, 404)
  const controller = deps.researchCliPreparation
  const scope = { campaignId, workspaceId: deps.workspaceId, workspaceRoot: deps.workspaceRoot }
  if (request.method === 'GET' && match[2] === 'catalog')
    return json({ routes: controller?.catalog() ?? [] })
  if (request.method === 'GET' && !match[2]) return json({ campaign })
  if (request.method === 'GET' && match[2] === 'candidate') {
    try {
      return json(
        await readCliCandidateView(
          campaign,
          deps.workspaceRoot,
          url.searchParams.get('preparationId') ?? '',
        ),
      )
    } catch {
      return json({ error: '候选内容暂不可核验，请刷新账本后重试。' }, 409)
    }
  }
  if (!controller)
    return json({ error: '尚未配置可执行的远端 CLI 工具。登录探测不授予执行权限。' }, 409)
  try {
    if (request.method === 'GET' && match[2] === 'approval')
      return json({ body: controller.approval(scope, url.searchParams.get('preparationId') ?? '') })
    if (request.method !== 'POST')
      return new Response('', { status: 405, headers: { allow: 'GET, POST' } })
    const value = await request.json().catch(() => null)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return json({ error: 'invalid_request' }, 400)
    const body = value as Record<string, unknown>
    const string = (key: string) => (typeof body[key] === 'string' ? body[key] : '')
    const number = (key: string) => (typeof body[key] === 'number' ? body[key] : Number.NaN)
    const exact = (keys: string[]) => Object.keys(body).sort().join(',') === keys.sort().join(',')
    switch (match[2]) {
      case 'propose':
        if (
          !exact([
            'expectedVersion',
            'idempotencyKey',
            'routeId',
            'taskRevisionId',
            'instructions',
            'maxRuntimeMs',
            'maxCost',
            'acknowledgeUnknownCost',
          ])
        )
          return json({ error: 'invalid_request' }, 400)
        if (body.acknowledgeUnknownCost !== true)
          return json({ error: 'unknown_cost_acknowledgement_required' }, 400)
        return json(
          controller.propose(scope, {
            expectedVersion: number('expectedVersion'),
            idempotencyKey: string('idempotencyKey'),
            routeId: string('routeId'),
            taskRevisionId: string('taskRevisionId'),
            instructions: string('instructions'),
            maxRuntimeMs: number('maxRuntimeMs'),
            maxCost: number('maxCost'),
            acknowledgeUnknownCost: true,
          }),
          201,
        )
      case 'submit':
        if (!exact(['preparationId', 'approvalId', 'expectedVersion']))
          return json({ error: 'invalid_request' }, 400)
        return json(
          await controller.submit(scope, {
            preparationId: string('preparationId'),
            approvalId: string('approvalId'),
            expectedVersion: number('expectedVersion'),
          }),
          202,
        )
      case 'reconcile':
      case 'cancel':
        if (!exact(['attemptId']) || typeof body.attemptId !== 'string')
          return json({ error: 'invalid_request' }, 400)
        return json(await controller[match[2]](scope, body.attemptId))
      default:
        return new Response('', { status: 405 })
    }
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : '准备操作失败' },
      error instanceof CliPreparationControlError ? error.status : 400,
    )
  }
}
