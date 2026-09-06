import type { ToolContext, ToolSpec } from '@oph-autoresearch/agent'
import type { ResearchControlOperation } from '@oph-autoresearch/core'

const OPERATIONS: ResearchControlOperation[] = [
  'prepare',
  'propose',
  'submit',
  'status',
  'events',
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
    '在当前会话已授权的 research campaign 上准备、提案、提交、查询、取消、对账、读取回执、请求模型审查或读取/记录不可变研究文档。每次写入必须带 expectedVersion 和 idempotencyKey。此工具不能审批、签名、撤销审批或发布。',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: OPERATIONS },
      campaign_id: { type: 'string' },
      body: { type: 'object', additionalProperties: true },
    },
    required: ['operation', 'campaign_id'],
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
      typeof args.campaign_id !== 'string' ||
      !args.campaign_id.trim()
    )
      return { status: 'failure', message: 'operation 或 campaign_id 无效' }
    if (
      args.body !== undefined &&
      (!args.body || typeof args.body !== 'object' || Array.isArray(args.body))
    )
      return { status: 'failure', message: 'body 必须是对象' }
    const result = await ctx.researchControl.execute({
      operation: args.operation as ResearchControlOperation,
      campaignId: args.campaign_id,
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
