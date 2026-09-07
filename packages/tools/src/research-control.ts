import type { ToolContext, ToolSpec } from '@oph-autoresearch/agent'
import type { ResearchControlOperation } from '@oph-autoresearch/core'

const OPERATIONS: ResearchControlOperation[] = [
  'list',
  'knowledge/search',
  'context',
  'workflow/preset',
  'literature/import',
  'evidence/fetch',

  'preflight',
  'prepare',
  'propose',
  'submit',
  'status',
  'events',
  'next_actions',
  'cancel',
  'reconcile',
  'receipt',
  'request_review',
  'documents/read',
  'record_document/write',
  'cli_preparation/propose',
  'cli_preparation/submit',
  'cli_preparation/status',
  'cli_preparation/cancel',
  'cli_preparation/reconcile',
  'cli_preparation/catalog',
]

export const researchControlTool: ToolSpec = {
  name: 'research_control',
  description:
    '通过聊天推进研究。context 获取已有项目、资料和文档字段；prepare 用 body {goal,idempotencyKey} 在当前会话创建研究。workflow/preset 的 body.phase 为 discovery/preparation/writing/peerreview，返回参数后实际调用 workflow。evidence/fetch 保存公开正文；literature/import 登记 DOI/PMID；record_document/write 保存文献、刊会、study、handoff、审稿案例及稿件版本。preflight 仅检查正式执行准备，不阻止调研。campaign_id 可省略，单个研究自动选择。不能确认人类方案、审批、签名或发布。',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: OPERATIONS },
      campaign_id: { type: ['string', 'null'] },
      body: { type: ['object', 'null'], additionalProperties: true },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '研究控制',
  category: 'planning',
  facet: '受控研究',
  summary: '在已授权 campaign 上执行受控操作',
  permissionEffect: 'internal_control',
  parallelSafe: false,
  targetExtractor: (args) => (typeof args.campaign_id === 'string' ? args.campaign_id : null),
  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    if (!ctx.researchControl)
      return { status: 'failure', message: '本次会话没有受控研究 capability' }
    if (
      typeof args.operation !== 'string' ||
      !OPERATIONS.includes(args.operation as ResearchControlOperation) ||
      (args.campaign_id != null && typeof args.campaign_id !== 'string')
    )
      return { status: 'failure', message: 'operation 或 campaign_id 无效' }
    if (
      args.body != null &&
      (!args.body || typeof args.body !== 'object' || Array.isArray(args.body))
    )
      return { status: 'failure', message: 'body 必须是对象' }
    const result = await ctx.researchControl.execute({
      operation: args.operation as ResearchControlOperation,
      campaignId: typeof args.campaign_id === 'string' ? args.campaign_id.trim() : '',
      ...(args.body ? { body: args.body as Record<string, unknown> } : {}),
    })
    return result.ok
      ? {
          status: 'success',
          message: `研究控制操作完成（HTTP ${result.status}）`,
          data: { response: result.data },
        }
      : {
          status: 'failure',
          message: `研究控制操作被拒绝（HTTP ${result.status}）`,
          data: { response: result.data },
        }
  },
}
