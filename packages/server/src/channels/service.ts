/** Feishu lifecycle, event notifications and replies for existing main conversations. */
import { createHash } from 'node:crypto'
import {
  type ConversationId,
  type EventEnvelope,
  foldWorkflow,
  workflowCheckpointDetails,
  workflowGroupId,
} from '@oph-autoresearch/core'
import {
  findRunByClientRequest,
  getConversation,
  getRun,
  listConversations,
  listResearchCampaigns,
  listSteps,
  listWorkspaces,
} from '@oph-autoresearch/store'
import { handleCommand } from '../commands.ts'
import { workflowRecords } from '../delegate.ts'
import type { CommandDeps } from '../deps.ts'
import { FeishuClient, feishuAdapters } from '../feishu-adapter.ts'
import { loadRemoteChannels, setRemoteChannelConnectionState } from '../remote-channels.ts'
import type {
  ResearchNotificationCoordinator,
  ResearchNotificationPayload,
} from '../research-notifications.ts'
import { FeishuConnection } from './feishu.ts'
import { type InboundMessage, routeInbound } from './route.ts'

type Deps = Omit<CommandDeps, 'ws'>
export function createFeishuService(
  deps: Deps,
  link: (payload: ResearchNotificationPayload, paired: boolean) => string,
  transport: {
    http?: typeof fetch
    socketFactory?: ConstructorParameters<typeof FeishuConnection>[4]
  } = {},
) {
  const channels = loadRemoteChannels().filter(
    (channel) => channel.enabled && process.env[channel.secretEnv] && channel.allowFrom.length,
  )
  const clients = channels.map((channel) => ({
    channel,
    client: new FeishuClient(channel, transport.http),
  }))
  const pending = new Map<
    string,
    { client: FeishuClient; chatId: string; messageId: string; conversationId: ConversationId }
  >()
  const decisions = new Map<string, { client: FeishuClient; chatId: string; messageId: string }>()
  const adapters = clients.flatMap(({ channel, client }) =>
    feishuAdapters(channel, client, (payload, paired) =>
      link(
        payload.kind === 'job_finished' && channel.conversationId
          ? { ...payload, conversationId: channel.conversationId }
          : payload,
        paired,
      ),
    ).map((adapter) => ({
      ...adapter,
      accepts: (payload: ResearchNotificationPayload) =>
        !channel.conversationId ||
        payload.conversationId === channel.conversationId ||
        (payload.kind === 'job_finished' &&
          getConversation(deps.store, channel.conversationId as ConversationId)?.workspaceId ===
            payload.campaign.workspaceId),
    })),
  )
  let notifications: ResearchNotificationCoordinator | undefined
  let unsubscribe: (() => void) | undefined
  let closed = false
  const connections = clients
    .filter(({ channel }) => channel.chatId && channel.conversationId)
    .map(({ channel, client }) => {
      const reply = (id: string, text: string) =>
        client.send(channel.chatId!, 'chat_id', { text }, 'text', `${id}:${text}`, undefined, id)
      const receive = async (sender: string, message: InboundMessage) => {
        if (closed) return
        const current = loadRemoteChannels().find(
          (item) => item.id === channel.id && item.appId === channel.appId,
        )
        if (!current) return
        const route = routeInbound(current, sender, message)
        if (route.kind === 'reject') {
          if (!route.silent) await reply(message.id, route.reason)
          return
        }
        const conversationId = (
          route.kind === 'decision' ? route.binding.conversationId : route.conversationId
        ) as ConversationId
        const conversation = getConversation(deps.store, conversationId)
        if (!conversation || conversation.parentConversationId) {
          await reply(message.id, '绑定的主会话不存在')
          return
        }
        if (route.kind === 'decision') {
          const result = await handleCommand(
            {
              type: 'workflow.review',
              conversationId,
              workflowId: route.binding.workflowId,
              checkpointId: route.binding.checkpointId,
              expectedStepId: route.binding.reviewStepId,
              decision: route.decision,
              note: route.note,
            },
            deps,
          )
          if (result?.ok)
            decisions.set(result.runId, { client, chatId: channel.chatId!, messageId: message.id })
          await reply(
            message.id,
            result?.ok ? '决策已接受，工作流继续执行' : (result?.error ?? '决策失败'),
          )
          return
        }
        if (route.kind === 'interrupt') {
          const run = deps.runs.listActive().find((item) => item.conversationId === conversationId)
          if (!run) {
            await reply(message.id, '当前没有运行中的任务')
            return
          }
          await handleCommand({ type: 'run.interrupt', runId: run.runId }, deps)
          await reply(message.id, '已请求停止')
          return
        }
        const requestId = `feishu:${channel.id}:${message.id}`
        if (pending.has(requestId) || findRunByClientRequest(deps.store, conversationId, requestId))
          return
        pending.set(requestId, {
          client,
          chatId: channel.chatId!,
          messageId: message.id,
          conversationId,
        })
        await handleCommand(
          { type: 'message.send', clientRequestId: requestId, conversationId, content: route.text },
          deps,
        )
      }
      return new FeishuConnection(
        channel,
        client,
        receive,
        (status) => setRemoteChannelConnectionState(channel.id, status),
        transport.socketFactory,
      )
    })

  const handleEvent = async (frame: EventEnvelope) => {
    if (!frame.conversationId || closed) return
    const event = frame.event
    const conversation = getConversation(deps.store, frame.conversationId)
    if (!conversation) return
    const campaign = listResearchCampaigns(
      deps.store,
      conversation.workspaceId,
      frame.conversationId,
    )[0]
    const common = {
      campaignId: campaign?.id ?? `conversation:${frame.conversationId}`,
      occurredAt: frame.at,
      conversationId: frame.conversationId,
      campaign: {
        id: campaign?.id ?? '',
        workspaceId: conversation.workspaceId,
        stage: campaign?.stage ?? '',
        status: campaign?.status ?? '',
      },
    }
    if (
      event.type === 'team.member' &&
      event.phase === 'waiting_review' &&
      event.reviewer === 'human' &&
      event.workflowId &&
      event.stepId
    ) {
      const folded = foldWorkflow(
        workflowRecords(deps.store, frame.conversationId),
        event.workflowId,
      )
      notifications?.publishOperational({
        ...common,
        kind: 'human_checkpoint',
        eventId: `workflow:${event.workflowId}:${event.stepId}`,
        ...(folded.ok
          ? {
              checkpointDetails: workflowCheckpointDetails(
                folded.projection.nodes,
                folded.projection.results,
                event.memberId,
              ),
            }
          : {}),
        workflow: {
          workflowId: event.workflowId,
          checkpointId: event.memberId,
          conversationId: frame.conversationId,
          reviewStepId: event.stepId,
        },
      })
    } else if (event.type === 'ssh.job.finished') {
      notifications?.publishOperational({
        ...common,
        kind: 'job_finished',
        eventId: `job:${createHash('sha256')
          .update(JSON.stringify([event.profile, event.runDir, event.state]))
          .digest('hex')}`,
        job: { state: event.state, ...(event.reason ? { reason: event.reason } : {}) },
      })
    } else if (event.type === 'run.error' && !event.runId) {
      const queued = new Set(deps.runs.queueOf(frame.conversationId).map((item) => item.id))
      for (const [requestId, source] of pending) {
        if (
          source.conversationId !== frame.conversationId ||
          queued.has(requestId) ||
          findRunByClientRequest(deps.store, frame.conversationId, requestId)
        )
          continue
        pending.delete(requestId)
        await source.client.send(
          source.chatId,
          'chat_id',
          { text: '本轮未能启动，请在 Web 查看错误' },
          'text',
          `rejected:${requestId}`,
          undefined,
          source.messageId,
        )
      }
    } else if (event.type === 'run.finished') {
      const decision = decisions.get(event.runId)
      if (decision) {
        decisions.delete(event.runId)
        await decision.client.send(
          decision.chatId,
          'chat_id',
          {
            text:
              event.status === 'done' ? '本批工作流已完成' : '本批工作流未完成，请查看 Web 回执',
          },
          'text',
          `decision:${event.runId}`,
          undefined,
          decision.messageId,
        )
      }
      const run = getRun(deps.store, event.runId)
      const source = run ? pending.get(run.clientRequestId) : undefined
      if (!source || !run || source.conversationId !== frame.conversationId) return
      pending.delete(run.clientRequestId)
      const final =
        listSteps(deps.store, event.runId)
          .filter((step) => step.kind === 'text')
          .at(-1)
          ?.content?.trim() || `本轮结束：${event.status}`
      const url = link(
        {
          schema: 'research-notification-v1',
          deliveryKey: '',
          eventId: event.runId,
          campaignSeq: 0,
          kind: 'completed',
          ...common,
        },
        false,
      )
      const text =
        Array.from(final).slice(0, 6000).join('') +
        (Array.from(final).length > 6000 ? `\n完整内容见 Web：${url}` : '')
      await source.client.send(
        source.chatId,
        'chat_id',
        { text },
        'text',
        `reply:${event.runId}`,
        undefined,
        source.messageId,
      )
    }
  }
  return {
    adapters,
    start(coordinator?: ResearchNotificationCoordinator) {
      notifications = coordinator
      unsubscribe = deps.bus.subscribe({
        id: 'feishu-service',
        origin: 'external',
        conversations: null,
        send: (frame) => {
          void handleEvent(frame).catch(() => console.warn('飞书通知或回复失败'))
        },
      })
      if (coordinator)
        for (const workspace of listWorkspaces(deps.store)) {
          for (const conversation of listConversations(deps.store, workspace.id)) {
            const records = workflowRecords(deps.store, conversation.id)
            for (const initial of records.filter(
              (record) => workflowGroupId(record) === record.stepId,
            )) {
              const folded = foldWorkflow(records, initial.stepId)
              if (
                !folded.ok ||
                folded.projection.phase !== 'waiting_review' ||
                !folded.projection.reviewStepId
              )
                continue
              const checkpoint = folded.projection.nodes.find(
                (node) => node.id === folded.projection.checkpointId,
              )
              if (checkpoint?.kind !== 'checkpoint' || checkpoint.reviewer !== 'human') continue
              deps.bus.publish(
                {
                  type: 'team.member',
                  runId: '' as never,
                  memberId: checkpoint.id,
                  roleName: checkpoint.label,
                  backend: 'builtin',
                  phase: 'waiting_review',
                  reviewer: 'human',
                  workflowId: initial.stepId,
                  stepId: folded.projection.reviewStepId,
                },
                conversation.id,
              )
            }
          }
        }
      for (const connection of connections) void connection.start()
    },
    close() {
      closed = true
      unsubscribe?.()
      for (const connection of connections) connection.close()
      pending.clear()
      decisions.clear()
    },
  }
}
