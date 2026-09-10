/** Human decisions use the existing run/step ledger and workflow executor. */
import {
  type ClientCommand,
  type ConversationId,
  foldWorkflow,
  type ToolOutcomeWire,
  workflowGroupId,
} from '@oph-autoresearch/core'
import {
  appendMessage,
  appendStep,
  createRun,
  finishRun,
  getConversation,
  markRunRunning,
  markStepExecuting,
  settleToolStep,
  touchRun,
  workspaceOf,
} from '@oph-autoresearch/store'
import { makeDelegate, workflowRecords } from './delegate.ts'
import type { CommandDeps } from './deps.ts'

type Decision = Extract<ClientCommand, { type: 'workflow.review' }>
type Deps = Omit<CommandDeps, 'ws'>

export function decideWorkflow(
  cmd: Decision,
  deps: Deps,
): { ok: true; runId: string } | { ok: false; error: string } {
  if (
    !cmd.conversationId ||
    !cmd.workflowId ||
    !cmd.checkpointId ||
    !cmd.expectedStepId ||
    !['approve', 'revise'].includes(cmd.decision) ||
    typeof cmd.note !== 'string'
  )
    return { ok: false, error: '检查点决策参数无效' }
  const conversation = getConversation(deps.store, cmd.conversationId)
  const workspace = workspaceOf(deps.store, cmd.conversationId)
  if (!conversation || !workspace || conversation.parentConversationId)
    return { ok: false, error: '主会话不存在' }
  if (!deps.runs.reserve(cmd.conversationId))
    return { ok: false, error: '会话正在执行，请稍后重试' }
  try {
    const records = workflowRecords(deps.store, cmd.conversationId)
    const folded = foldWorkflow(records, cmd.workflowId)
    if (!folded.ok) throw new Error(folded.error)
    const projection = folded.projection
    const latest = records
      .filter((record) => workflowGroupId(record) === cmd.workflowId && record.outcome?.data?.phase)
      .at(-1)
    if (
      projection.phase !== 'waiting_review' ||
      projection.checkpointId !== cmd.checkpointId ||
      latest?.stepId !== cmd.expectedStepId
    )
      throw new Error('检查点已被处理，请刷新后重试')
    const checkpoint = projection.nodes.find((node) => node.id === cmd.checkpointId)
    if (checkpoint?.kind !== 'checkpoint' || checkpoint.reviewer !== 'human')
      throw new Error('该检查点由主会话审查')
    if (cmd.decision === 'revise' && !cmd.note.trim()) throw new Error('请填写返工意见')
    const revisions =
      cmd.decision === 'revise'
        ? checkpoint.needs
            .filter((id) =>
              projection.nodes.some((node) => node.id === id && node.kind !== 'checkpoint'),
            )
            .map((nodeId) => ({ nodeId, instruction: cmd.note.trim() }))
        : []
    if (cmd.decision === 'revise' && revisions.length === 0)
      throw new Error('该检查点没有可返工节点')
    const args = {
      workflowId: cmd.workflowId,
      checkpointId: cmd.checkpointId,
      decision: cmd.decision,
      note: cmd.note,
      revisions,
    }
    const message = appendMessage(deps.store, {
      conversationId: cmd.conversationId,
      role: 'user',
      content: `${cmd.decision === 'approve' ? '批准' : '返工'}：${checkpoint.label}${cmd.note ? `\n${cmd.note}` : ''}`,
    })
    const run = createRun(deps.store, {
      conversationId: cmd.conversationId,
      workspaceId: workspace.id,
      model: conversation.model,
      clientRequestId: crypto.randomUUID(),
      userMessageId: message.id,
      messageIdUpperBound: message.id,
      contextSnapshot: [],
    })
    const action = { kind: 'run' as const, objectLabel: '编排', target: cmd.workflowId }
    const step = appendStep(deps.store, {
      runId: run.id,
      seq: 0,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: `human:${run.id}`,
      status: 'running',
      payload: { kind: 'tool_call', args, action },
    })
    markStepExecuting(deps.store, step.id)
    markRunRunning(deps.store, run.id)
    const controller = new AbortController()
    deps.runs.disarm(cmd.conversationId)
    deps.runs.register({
      runId: run.id,
      conversationId: cmd.conversationId,
      controller,
      startedAt: Date.now(),
    })
    deps.bus.publish(
      {
        type: 'run.started',
        runId: run.id,
        conversationId: cmd.conversationId,
        model: run.model,
        userMessageId: message.id,
        userMessage: { content: message.content },
      },
      cmd.conversationId,
    )
    deps.bus.publish(
      {
        type: 'tool.started',
        runId: run.id,
        stepId: step.id,
        toolCallId: `human:${run.id}`,
        toolName: 'workflow',
        batchId: `human:${run.id}`,
        callIndex: 0,
        waveIndex: 0,
        args,
        action,
      },
      cmd.conversationId,
    )
    void (async () => {
      const started = Date.now()
      const heartbeat = setInterval(() => touchRun(deps.store, run.id), 10_000)
      let outcome: ToolOutcomeWire
      try {
        const result = await makeDelegate({
          deps,
          workspaceRoot: workspace.rootPath,
          conversationId: cmd.conversationId,
        }).runGraph({
          call: { kind: 'review', ...args },
          origin: 'human',
          runId: run.id,
          stepId: step.id,
          signal: controller.signal,
        })
        outcome = {
          executed: true,
          status: result.ok ? 'success' : 'failure',
          message: result.error ?? '人类决策已执行',
          ...(result.transition
            ? { data: result.transition as unknown as Record<string, unknown> }
            : {}),
        }
      } catch (error) {
        outcome = {
          executed: true,
          status: 'failure',
          message: error instanceof Error ? error.message : '检查点执行失败',
        }
      }
      clearInterval(heartbeat)
      const status = outcome.status === 'success' ? 'success' : 'failure'
      const durationMs = Date.now() - started
      settleToolStep(
        deps.store,
        step.id,
        status,
        { kind: 'tool_result', args, action, outcome },
        durationMs,
      )
      deps.bus.publish(
        {
          type: 'tool.finished',
          runId: run.id,
          stepId: step.id,
          status,
          outcome,
          toolCallId: `human:${run.id}`,
          durationMs,
        },
        cmd.conversationId,
      )
      announceHumanCheckpoint(deps, cmd.conversationId, run.id, step.id, outcome)
      const finish = {
        status: controller.signal.aborted
          ? ('interrupted' as const)
          : status === 'success'
            ? ('done' as const)
            : ('failed' as const),
        stopReason: controller.signal.aborted
          ? ('user_interrupt' as const)
          : status === 'success'
            ? ('completed' as const)
            : ('internal_guard' as const),
      }
      finishRun(deps.store, run.id, finish)
      deps.runs.unregister(run.id)
      deps.bus.publish(
        { type: 'run.finished', runId: run.id, ...finish, usage: run.usage, fileChanges: [] },
        cmd.conversationId,
      )
    })().catch(() => {
      finishRun(deps.store, run.id, {
        status: 'failed',
        stopReason: 'internal_guard',
        errorMessage: '人类决策回执保存失败',
      })
      deps.runs.unregister(run.id)
      deps.bus.publish(
        {
          type: 'run.error',
          runId: run.id,
          code: 'internal_error',
          message: '人类决策回执保存失败',
        },
        cmd.conversationId,
      )
      deps.bus.publish(
        {
          type: 'run.finished',
          runId: run.id,
          status: 'failed',
          stopReason: 'internal_guard',
          usage: run.usage,
          fileChanges: [],
        },
        cmd.conversationId,
      )
    })
    return { ok: true, runId: run.id }
  } catch (error) {
    deps.runs.release(cmd.conversationId)
    return { ok: false, error: error instanceof Error ? error.message : '检查点决策失败' }
  }
}

export function announceHumanCheckpoint(
  deps: Deps,
  conversationId: ConversationId,
  runId: string,
  stepId: string,
  outcome: ToolOutcomeWire,
): void {
  const data = outcome.data
  if (
    data?.phase !== 'waiting_review' ||
    data.reviewer !== 'human' ||
    typeof data.workflowId !== 'string'
  )
    return
  const folded = foldWorkflow(workflowRecords(deps.store, conversationId), data.workflowId)
  if (!folded.ok) return
  const checkpoint = folded.projection.nodes.find((node) => node.id === data.checkpointId)
  if (checkpoint?.kind !== 'checkpoint') return
  deps.bus.publish(
    {
      type: 'team.member',
      runId: runId as never,
      stepId,
      memberId: checkpoint.id,
      roleName: checkpoint.label,
      backend: 'builtin',
      phase: 'waiting_review',
      reviewer: 'human',
      workflowId: data.workflowId,
    },
    conversationId,
  )
}
