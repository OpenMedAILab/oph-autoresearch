/** 主对话的原生 CLI 执行：会话及回执仍写入同一本账本。 */
import type { AgentEvent, Attachment, ConversationId, RunUsage } from '@oph-autoresearch/core'
import { collectSecrets, type OphConfig } from '@oph-autoresearch/runtime'
import {
  appendMessage,
  appendStep,
  createRun,
  finishRun,
  getConversation,
  listMessages,
  listRuns,
  listSteps,
  markRunRunning,
  type Store,
  setConversationTitle,
  updateRunUsage,
  workspaceOf,
} from '@oph-autoresearch/store'
import { findCli, runCli } from '@oph-autoresearch/team'
import { cliCatalogSnapshot } from './cli-catalog.ts'
import { RESEARCH_ASSISTANT_INSTRUCTION } from './research/research-assistant.ts'
import { resolveWorkspaceServerBinding } from './workspace-binding.ts'

export const CLI_PROVIDER_PREFIX = 'cli:'
const MODEL_CLI = new Set(['codex', 'claude', 'grok'])
export function supportsCliModel(id: string): boolean {
  return MODEL_CLI.has(id)
}

/** A short-lived, campaign-scoped local bridge supplied by the server host. */
export interface NativeResearchControlBridge {
  endpoint: string
  token: string
  campaignIds: readonly string[]
  conversationId?: string
}

export class CliConversationSession {
  constructor(
    private opts: {
      store: Store
      config: OphConfig
      workspaceRoot: string
      signal: AbortSignal
      researchControl?: NativeResearchControlBridge
    },
  ) {}
  dispose(): void {}

  async *ask(
    prompt: string,
    conversationId: ConversationId,
    options?: { model?: string; attachments?: Attachment[]; clientRequestId?: string },
  ): AsyncGenerator<AgentEvent> {
    const { store, signal } = this.opts
    const conversation = getConversation(store, conversationId)!
    const ws = workspaceOf(store, conversationId)!
    const model = options?.model ?? conversation.model
    const cliId = conversation.provider.slice(CLI_PROVIDER_PREFIX.length)
    // CLI 每轮得到完整的用户/助手记录，不依赖临时进程或浏览器中的会话状态。
    const history: string[] = []
    const runs = listRuns(store, conversationId)
    for (const message of listMessages(store, conversationId)) {
      history.push(`${message.role}: ${message.content}`)
      for (const run of runs.filter((item) => item.userMessageId === message.id)) {
        const answer = listSteps(store, run.id)
          .filter((step) => step.kind === 'text')
          .map((step) => step.content ?? '')
          .join('\n')
        if (answer) history.push(`assistant: ${answer}`)
      }
    }
    const message = appendMessage(store, {
      conversationId,
      role: 'user',
      content: prompt,
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
    })
    if (!conversation.title) setConversationTitle(store, conversationId, prompt.slice(0, 80))
    const run = createRun(store, {
      conversationId,
      workspaceId: ws.id,
      model,
      clientRequestId: options?.clientRequestId ?? crypto.randomUUID(),
      userMessageId: message.id,
      messageIdUpperBound: message.id,
      contextSnapshot: [],
    })
    markRunRunning(store, run.id)
    yield {
      type: 'run.started',
      runId: run.id,
      conversationId,
      model,
      userMessageId: message.id,
      userMessage: { content: prompt },
    }
    let failure: string | undefined
    try {
      if (options?.attachments?.length)
        throw new Error(
          'CLI 对话目前支持文本输入。请在消息中引用项目内的文件路径，或切换 API 模型发送附件。',
        )
      if (cliId.startsWith('ssh:')) throw new Error('远程 CLI 仅用于实验执行，请选择本机主控模型')
      const cli = await findCli(cliId)
      if (!cli)
        throw new Error(`${cliId} CLI 未安装或不在服务进程的 PATH 中，请安装后刷新模型列表。`)
      if (model !== 'default' && !supportsCliModel(cliId))
        throw new Error('该 CLI 请使用默认模型，并在 CLI 自身配置中切换模型。')
      const boundServer = ws.serverBinding ? await resolveWorkspaceServerBinding(ws) : null
      const remoteCapabilities = cliCatalogSnapshot()
        .agents.filter((a) => boundServer && a.profileId === boundServer.binding.profileId)
        .map((a) => ({
          profile: a.profileId,
          location: a.location,
          cli: a.id,
          path: a.path,
          status: a.probe?.status,
          models: a.probe?.models,
          checkedAt: a.probe?.checkedAt,
        }))
      const control = this.opts.researchControl
      const controlClientArgv = Bun.main.endsWith('.ts')
        ? [process.execPath, Bun.main]
        : [process.execPath]
      const controlCommand = controlClientArgv.map((arg) => JSON.stringify(arg)).join(' ')
      const controlInstruction = control
        ? `\n开始研究时先运行 research context 读取项目资料；正式实验前才运行 research preflight，使用 research list 发现本会话最新提案；单个提案可省略 --campaign，多个提案按目标选择，不向用户索取或展示内部 ID。CLI 登录与 SSH 可用不能代替正式执行准入。受控研究操作只能通过 \`${controlCommand} research\` 调用本轮注入的本地桥。服务端将能力限定在当前会话：可用 prepare 从主题创建研究，context 读取资料，knowledge/search 检索项目刊会知识，workflow/preset 获取流程，documents/read 与 record_document/write 管理资料；正式实验沿用 propose/submit/status/events/cancel/reconcile/receipt/request_review。它不能确认人类方案、审批、签名或发布。每次变更都必须带 ledger 要求的 expectedVersion 和 idempotencyKey。\n`
        : ''
      const bindingContext = boundServer
        ? `本机项目工作目录：${ws.rootPath}；绑定的服务器工作目录：${boundServer.binding.remoteRoot}。本机保存对话、方案和产物索引，服务器目录用于代码与实验；目录绑定不代表自动文件同步。`
        : '此历史项目尚未绑定服务器工作目录，请先在项目侧栏完成绑定再安排远程实验。'
      const input = `${RESEARCH_ASSISTANT_INSTRUCTION}\n原生 CLI 使用下面的 research 桥命令读取预设；若自身不支持子代理，请明确该限制，不把返回预设声称已派发。\n${bindingContext}\n远程执行端能力清单（仅状态，不是实验执行授权）：${JSON.stringify(remoteCapabilities)}。本机负责规划与审核；远程 CLI 用于受控实验，不是主控模型。${controlInstruction}
你正在项目 ${this.opts.workspaceRoot} 中处理研究对话。以下历史仅作为上下文，回答最后一条用户消息。\n${history.join('\n\n')}\n\nuser: ${prompt}`
      if (Buffer.byteLength(input) > 96_000)
        throw new Error(
          '此 CLI 对话的历史已超过单次输入上限，请新建对话并引用需要的研究文件。历史未被截断。',
        )
      if (signal.aborted) throw new Error('已停止')
      // 主对话沿用 CLI 自身权限设置，不继承团队派活模板中的自动批准参数。
      const nativeArgs = cli.args.filter(
        (arg, index, all) =>
          arg !== '--always-approve' &&
          arg !== '--permission-mode' &&
          all[index - 1] !== '--permission-mode',
      )
      const agent = {
        ...cli,
        args: model === 'default' ? nativeArgs : ['--model', model, ...nativeArgs],
      }
      // Codex 的模型参数属于 exec 子命令。
      if (model !== 'default' && cliId === 'codex')
        agent.args = ['exec', '--model', model, ...nativeArgs.slice(1)]
      const result = await runCli(agent, {
        prompt: input,
        workspaceRoot: this.opts.workspaceRoot,
        signal,
        secrets: collectSecrets(this.opts.config),
        ...(control
          ? {
              env: {
                OPH_RESEARCH_CONTROL_ENDPOINT: control.endpoint,
                OPH_RESEARCH_CONTROL_TOKEN: control.token,
                OPH_RESEARCH_CONTROL_CAMPAIGNS: control.campaignIds.join(','),
                OPH_RESEARCH_CONTROL_CONVERSATION: control.conversationId ?? '',
                OPH_RESEARCH_CONTROL_CLIENT_ARGV: JSON.stringify(controlClientArgv),
              },
            }
          : {}),
      })
      if (signal.aborted) throw new Error('已停止')
      if (!result.ok)
        throw new Error(
          result.timedOut
            ? 'CLI 执行超时'
            : result.stderr || result.output || `CLI 退出码 ${result.exitCode}`,
        )
      if (!result.output.trim())
        throw new Error('CLI 未返回可显示的回答，请检查 CLI 登录状态和模型配置。')
      const step = appendStep(store, {
        runId: run.id,
        seq: 0,
        kind: 'text',
        content: result.output,
      })
      yield { type: 'text.delta', runId: run.id, stepId: step.id, delta: result.output }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      if (!signal.aborted)
        yield { type: 'run.error', runId: run.id, code: 'internal_error', message: failure }
    }
    const status = signal.aborted ? 'interrupted' : failure ? 'failed' : 'done'
    const stopReason = signal.aborted ? 'user_interrupt' : failure ? 'provider_error' : 'completed'
    finishRun(store, run.id, { status, stopReason, ...(failure ? { errorMessage: failure } : {}) })
    // CLI 账单由其自身管理；不伪造 API 计费明细。
    const usage: RunUsage = {
      reporting: 'unavailable',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      cost: null,
      currency: 'USD',
      turns: [],
    }
    updateRunUsage(store, run.id, usage)
    yield { type: 'run.finished', runId: run.id, status, stopReason, usage, fileChanges: [] }
  }
}
