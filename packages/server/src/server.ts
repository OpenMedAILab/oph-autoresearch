import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { globalScopeRoot } from '@oph-autoresearch/tools'
import { createFeishuService } from './channels/service.ts'
import { refreshCliCatalog } from './cli-catalog.ts'
import { createBoundedScheduler } from './research/bounded-scheduler.ts'
import {
  CliPreparationController,
  type CliPreparationRoute,
} from './research/cli-preparation-controller.ts'
import { captureResearchDeployment } from './research/deployment-governance.ts'
import { createResearchDevices, quoteResearchDevice } from './research/execution-devices.ts'
import {
  FormalExecutionController,
  type FormalExecutionRoute,
} from './research/formal-execution-controller.ts'
import { createConfiguredIsolatedFormalCodeReviewer } from './research/formal-review-runner.ts'
import { readFormalCandidate, resolveFormalScope } from './research/formal-runtime.ts'
import { createFormalSshRoute, type SshFormalExecutionRoute } from './research/formal-ssh-route.ts'
import { createHumanAuthVerifier, type HumanAuthVerifierConfig } from './research/human-auth.ts'
import { JobDaemon } from './research/job-daemon.ts'
import { createLiteratureCollector } from './research/literature-evidence.ts'
import type { RunnerTrackingConfig } from './research/runner-tracking.ts'
import { createSshDaemonClient, type SshDaemonConfig } from './research/ssh-daemon-client.ts'
/**
 * `oph serve` —— 本地 HTTP + WebSocket 服务。
 *
 * 桌面端和手机端连的是**同一个**服务、走**同一套**协议。桌面端并不通过 Tauri IPC
 * 拿数据，它就是这个服务的一个 Web 客户端——这样手机端不需要第二套后端，
 * 也不会出现「桌面能做但手机做不了」的能力漂移。
 *
 * 绑定地址的取舍：默认绑 0.0.0.0 才能让手机连上，但那也意味着同一 Wi-Fi 下
 * 任何设备都能触达。所以令牌鉴权是强制的，不是可选项（见 pairing.ts）。
 * 只想本机用就传 --host 127.0.0.1。
 */

import type {
  AgentEvent,
  ClientCommand,
  EventEnvelope,
  HelloFrame,
  ResearchExecutionBoundary,
  Workspace,
} from '@oph-autoresearch/core'
import { RESTRICTED_RESEARCH_CAPABILITY_DENIED } from '@oph-autoresearch/core'
import type { OphConfig } from '@oph-autoresearch/runtime'
import { acquireExtensions, collectSecrets, releaseExtensions } from '@oph-autoresearch/runtime'
import type { ProcessExitObservation, Store } from '@oph-autoresearch/store'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  getWorkspaceByPath,
  listResearchCampaigns,
  listResearchEvents,
  listWorkspaces,
  mostRecentWorkspace,
  recoverRunningSyntheticAttempts,
  recoverStaleRuns,
  upsertWorkspace,
} from '@oph-autoresearch/store'
import { isDue, loadSchedules, type Schedule, updateSchedules } from '@oph-autoresearch/tools'
import type { ServerWebSocket } from 'bun'
import { handleApi, json } from './api/index.ts'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import type { SocketData } from './deps.ts'
import { createGitWatch } from './git-watch.ts'
import { handleHello } from './handshake.ts'
import { CORS_HEADERS, hostLabel, serveStatic, withCors } from './http-util.ts'
import { extractToken, Pairing, preferredLanAddress } from './pairing.ts'
import { sanitizeProcessExitObservation } from './process-exit.ts'
import {
  createNativeResearchControlBridge,
  createResearchControlPort,
} from './research/native-research-control.ts'
import { publishResearchEvents } from './research-events.ts'
import {
  type ResearchNotificationConfig,
  ResearchNotificationCoordinator,
} from './research-notifications.ts'
import { ensureResearchWorkspace } from './research-template.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'

export interface ServeOptions {
  researchFormalExecution?: readonly (FormalExecutionRoute | SshFormalExecutionRoute)[]
  researchCliPreparation?: readonly (Omit<CliPreparationRoute, 'authority'> &
    ({ authority: CliPreparationRoute['authority'] } | { config: SshDaemonConfig }))[]
  /** Explicit administrator-owned external notification configuration. Disabled by default. */
  researchNotifications?: ResearchNotificationConfig
  researchReviewCli?: { workerArgv?: readonly string[] }
  researchDeployment?: unknown
  researchSshDaemon?: SshDaemonConfig
  researchSshDevices?: readonly { id: string; config: SshDaemonConfig }[]
  researchDaemon?: {
    dbPath: string
    outputRoot: string
    workerArgv?: readonly string[]
    tracking?: RunnerTrackingConfig
  }
  researchControllerOnly?: boolean
  researchHumanAuth?: HumanAuthVerifierConfig
  researchRequireApproval?: boolean
  /** Administrator-owned evaluator identities; clients can only bind one of these implementation digests. */
  researchFormalCatalog?: import('./api/types.ts').ApiDeps['researchFormalCatalog']
  researchFormalEvaluators?: readonly {
    id: 'binary-classification-v1'
    implementationHash: string
  }[]
  /** Trusted, immutable launch setting; never sourced from workspace or HTTP config. */
  researchBoundary?: ResearchExecutionBoundary
  store: Store
  config: OphConfig
  /**
   * 正文库。不传则自动挨着主账本开一个（`:memory:` 账本对应内存正文库）。
   * 超预算的工具输出落在这里，模型用 read_resource 读回。
   */
  content?: ContentStore
  /**
   * 启动时用哪个目录当项目。
   *
   * **不给是合法的，而且和「给了进程 cwd」不是一回事。** 不给 = 由服务端决定：
   * 账本里有项目就用最近打开的那个，一个都没有时等待用户新建研究项目。
   *
   * 把进程 cwd 当默认值是错的：桌面外壳的 cwd 是安装目录或 `src-tauri`，
   * 登记进去就成了一个谁也没要过的项目。
   */
  workspaceRoot?: string
  port: number
  host: string
  /** web 构建产物目录；不存在时只提供 API。 */
  staticDir?: string
  /** 由外部注入的令牌（Tauri spawn 时用环境变量传），不传则自己生成。 */
  token?: string
  /** 桌面外壳刚观察到的上一份 oph serve 终态。只用于本次启动的孤儿 run 回收。 */
  previousProcessExit?: ProcessExitObservation
}

/** 首次运行时建的那个工作区叫什么。已落盘的目录名是历史事实，别改（D2）。 */

/** 恢复显式指定或最近打开的项目；首次启动等待用户创建项目。 */
function bootstrapWorkspace(
  store: Store,
  explicitRoot?: string,
): { workspace: Workspace | null; rootPath: string } {
  if (explicitRoot) {
    const name = explicitRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    const known = getWorkspaceByPath(store, explicitRoot)
    return {
      workspace: upsertWorkspace(store, explicitRoot, known?.name ?? name),
      rootPath: explicitRoot,
    }
  }

  const recent = mostRecentWorkspace(store)
  if (recent) return { workspace: recent, rootPath: recent.rootPath }

  return { workspace: null, rootPath: '' }
}

export function serve(opts: ServeOptions) {
  if (
    [opts.researchDaemon, opts.researchSshDaemon, opts.researchSshDevices].filter(Boolean).length >
    1
  )
    throw new Error('Configure one research authority or one fixed device catalog')
  const researchHumanAuth = opts.researchHumanAuth
    ? createHumanAuthVerifier(opts.researchHumanAuth)
    : undefined
  const researchRequireApproval = opts.researchRequireApproval ?? Boolean(researchHumanAuth)
  const researchControllerOnly = opts.researchControllerOnly === true
  const researchBoundary = opts.researchBoundary ?? 'standard'
  const restricted = researchBoundary !== 'standard'
  const researchFormalCodeReviewer = restricted
    ? undefined
    : createConfiguredIsolatedFormalCodeReviewer(opts.config)
  const researchDeployment =
    opts.researchDeployment === undefined
      ? undefined
      : captureResearchDeployment(opts.researchDeployment, {
          host: opts.host,
          boundary: researchBoundary,
          humanAuth: opts.researchHumanAuth,
          requireApproval: researchRequireApproval,
          daemonConfigured: Boolean(
            opts.researchDaemon ||
              opts.researchSshDaemon ||
              opts.researchSshDevices ||
              opts.researchCliPreparation?.length ||
              opts.researchFormalExecution?.length,
          ),
        })
  const researchLiteratureCollector =
    !restricted && researchDeployment?.allowPublicMetadata !== false
      ? createLiteratureCollector({})
      : undefined
  const researchExecutionDevices =
    !restricted && opts.researchSshDevices
      ? createResearchDevices(opts.researchSshDevices)
      : undefined
  const researchDaemonBackend =
    !restricted && opts.researchSshDaemon
      ? { kind: 'ssh-daemon' as const, daemon: createSshDaemonClient(opts.researchSshDaemon) }
      : !restricted && opts.researchDaemon
        ? {
            daemon: new JobDaemon(opts.researchDaemon),
            ...(opts.researchDaemon.workerArgv
              ? { workerArgv: [...opts.researchDaemon.workerArgv] }
              : {}),
          }
        : undefined
  const bus = new EventBus()
  const runs = new RunManager(opts.store, bus)
  const gitWatch = createGitWatch(opts.store, bus)
  // 令牌只有这一个持有者。外部注入的也交给它，鉴权才只有一条路径。
  const pairing = new Pairing({
    deviceName: hostLabel(),
    ...(opts.token ? { token: opts.token } : {}),
  })
  const token = pairing.token

  const { workspace, rootPath: workspaceRoot } = bootstrapWorkspace(opts.store, opts.workspaceRoot)
  // 正文库与主账本挨着放。开在这里而不是每个 run 现开：SQLite 连接有成本，
  // 而且 GC 需要一个跨 run 存活的句柄。
  const content =
    opts.content ?? new ContentStore(contentPathFor(opts.store.db.filename || ':memory:'))
  const ownsContent = opts.content === undefined
  const feishu: ReturnType<typeof createFeishuService> | undefined = !restricted
    ? createFeishuService(
        {
          store: opts.store,
          content,
          config: opts.config,
          bus,
          runs,
          researchControllerOnly,
          researchControlFactory: ({
            workspaceId,
            workspaceRoot,
            campaignIds,
            signal,
            conversationId,
          }): ReturnType<typeof createNativeResearchControlBridge> =>
            createNativeResearchControlBridge(
              researchControlDeps(workspaceId, workspaceRoot),
              campaignIds,
              signal,
              undefined,
              conversationId,
            ),
          researchControlPortFactory: ({
            workspaceId,
            workspaceRoot,
            campaignIds,
            conversationId,
          }): ReturnType<typeof createResearchControlPort> =>
            createResearchControlPort(
              researchControlDeps(workspaceId, workspaceRoot),
              campaignIds,
              conversationId,
            ),
        },
        (payload, paired) => {
          const url = new URL(pairing.qrUrl(lanServer?.port ?? boundPort))
          const fragment = new URLSearchParams(url.hash.slice(1))
          if (!paired) {
            fragment.delete('t')
            fragment.delete('n')
          }
          if (payload.conversationId) fragment.set('conversation', payload.conversationId)
          if (payload.workflow) fragment.set('workflow', payload.workflow.workflowId)
          fragment.set('workspace', payload.campaign.workspaceId)
          url.hash = fragment.toString()
          return url.toString()
        },
      )
    : undefined
  if (feishu?.adapters.length) mkdirSync(globalScopeRoot(), { recursive: true })
  const notificationConfig: ResearchNotificationConfig | undefined =
    opts.researchNotifications ??
    (feishu?.adapters.length
      ? {
          ownDbPath: join(globalScopeRoot(), 'research-notifications.sqlite'),
          adapters: feishu.adapters,
        }
      : undefined)
  const researchNotifications: ResearchNotificationCoordinator | undefined =
    !restricted && notificationConfig
      ? new ResearchNotificationCoordinator(notificationConfig)
      : undefined
  const cliPreparationRoutes =
    !restricted && opts.researchCliPreparation
      ? opts.researchCliPreparation.map((route) => ({
          ...route,
          authority: 'authority' in route ? route.authority : createSshDaemonClient(route.config),
        }))
      : []
  const researchCliPreparation = cliPreparationRoutes.length
    ? new CliPreparationController(opts.store, cliPreparationRoutes, () =>
        publishResearchEvents(opts.store, bus, researchNotifications),
      )
    : undefined
  const formalSshClients: Array<{ close(): void }> = []
  const formalRoutes = !restricted
    ? (opts.researchFormalExecution ?? []).map((input) => {
        if ('authority' in input) return input
        const prepared = createFormalSshRoute(input)
        formalSshClients.push(prepared)
        return prepared.route
      })
    : []
  const formalController = formalRoutes.length
    ? new FormalExecutionController(
        opts.store,
        formalRoutes,
        { read: (plan, campaign) => readFormalCandidate(opts.store, plan, campaign) },
        () => publishResearchEvents(opts.store, bus, researchNotifications),
        (scope) => resolveFormalScope(opts.store, scope),
      )
    : undefined
  const researchFormalExecution = formalController
    ? { controller: formalController, routes: formalRoutes }
    : undefined
  const researchTemplate =
    restricted || !workspace ? { created: [] } : ensureResearchWorkspace(workspaceRoot)
  if (researchTemplate.created.length > 0) {
    process.stderr.write(`[oph] 已补齐研究工作区模板：${researchTemplate.created.join('、')}\n`)
  }

  /**
   * 预热启动那个项目的扩展，并全程持有一份引用。
   *
   * **扩展清单不在这里存一份给握手用。** 扩展里的 MCP 与编排是按工作区的
   * （`.agents/mcp.json`、`.oph/team.json` 在项目目录下），而一条 WebSocket 连接
   * 横跨用户开着的所有项目——存一份就等于「A 项目的 MCP 显示在 B 项目上」，
   * 而且只在重连时才更新。要看清单去各自的设置页，它们按项目现取。
   *
   * 这里仍然 acquire：各个 Session 再各自 acquire / release，引用计数保证
   * 子进程只起一套；服务持有一份让启动项目的插件不会在两轮之间被反复拉起又杀掉。
   * 异步、不阻塞服务启动——一个慢插件不该让整个服务起不来。
   */
  let pluginTeardown: (() => void) | null = null
  if (!restricted && !researchControllerOnly && workspace)
    void acquireExtensions(workspaceRoot, (line) => process.stderr.write(`${line}\n`))
      .then((ext) => {
        for (const f of ext.mcp.failures) {
          process.stderr.write(`[oph] MCP ${f.server}：${f.reason}\n`)
        }
        for (const f of ext.plugins.failures) {
          process.stderr.write(`[oph] 插件加载失败 ${f.dir}：${f.reason}\n`)
        }
        if (ext.team.error) process.stderr.write(`[oph] team 配置：${ext.team.error}\n`)
        pluginTeardown = () => releaseExtensions(workspaceRoot)
      })
      .catch((err) => {
        process.stderr.write(`[oph] 扩展加载失败：${String(err)}\n`)
      })

  // 回收上次进程留下的 running run。必须在开始服务**之前**做：
  // 留着不管的话 isBusy 会一直判真，用户在那个会话里发不出任何消息——会话被永久锁死。
  //
  // 只回收**没人在跑**的那些（判据见 `store/repos.ts` 的 `isOrphan`）。无差别
  // 回收的话，本进程一启动就把别的进程正在跑的那一轮判成中断——账本是共享的，
  // 而一台机器上同时可以有好几个写入者。
  const previousExit = opts.previousProcessExit
    ? sanitizeProcessExitObservation(opts.previousProcessExit, collectSecrets(opts.config))
    : undefined
  const stale = recoverStaleRuns(opts.store, previousExit)
  if (!restricted) {
    recoverRunningSyntheticAttempts(opts.store)
    if (formalController) {
      for (const existingWorkspace of listWorkspaces(opts.store)) {
        for (const campaign of listResearchCampaigns(opts.store, existingWorkspace.id)) {
          formalController.recover({
            workspaceId: existingWorkspace.id,
            workspaceRoot: existingWorkspace.rootPath,
            campaignId: campaign.id,
          })
        }
      }
    }
    if (researchCliPreparation) {
      for (const existingWorkspace of listWorkspaces(opts.store)) {
        for (const campaign of listResearchCampaigns(opts.store, existingWorkspace.id)) {
          researchCliPreparation.recover({
            workspaceId: existingWorkspace.id,
            workspaceRoot: existingWorkspace.rootPath,
            campaignId: campaign.id,
          })
        }
      }
    }
    if (researchNotifications) {
      const campaignIds = opts.store.db
        .query<{ id: string }, []>('SELECT id FROM research_campaigns')
        .all()
        .map((campaign) => campaign.id)
      researchNotifications.reconcile(
        campaignIds.flatMap((campaignId) => listResearchEvents(opts.store, campaignId)),
      )
    }
    publishResearchEvents(opts.store, bus, researchNotifications)
  }
  if (stale.recovered > 0) {
    process.stderr.write(
      `[oph] 已回收上次残留的 ${stale.recovered} 个执行记录` +
        (stale.ambiguous > 0 ? `，其中 ${stale.ambiguous} 个在工具执行期间中断，结果不可信` : '') +
        '\n',
    )
  }
  // 跳过的也要说。不说的话「回收了 0 个」有两种含义（没有残留 / 有但都还在运行），
  // 而这两种在排查「为什么那条会话还显示执行中」时是完全不同的方向。
  if (stale.heldByOthers > 0) {
    process.stderr.write(
      `[oph] 另有 ${stale.heldByOthers} 个执行记录由其它运行中的进程持有，未回收\n`,
    )
  }

  const unsubscribers = new Map<string, () => void>()

  /**
   * 定时任务调度器。
   *
   * **触发语义（这是本功能唯一真正的设计问题，不是工作量问题）**：
   * - **跑在哪个会话**：每次触发**新建一个会话**，标题取任务标题。
   *   复用同一个会话的话，几十次触发之后上下文会长到每一轮都在压缩，
   *   而且任务之间会互相看见——「每天的日报」不该记得昨天那次的中间过程。
   *   新建会话也让每次触发都留下一个可以点开的现场。
   * - **权限按谁算**：与手动发消息完全一致（同一个 `startRun`、同一份 config）。
   *   给定时任务单开一档权限等于造一条绕过裁决的路。
   * - **失败了谁看得见**：`lastError` 落进任务本身，界面上和这条任务显示在一起。
   *   只广播事件是不够的——触发时没人开着界面，事件没有接收者。
   * - **会话忙就跳过**：上一轮还没跑完就不叠加，跳过并记一句原因。
   *
   * **30 秒一跳。** 调度精度是分钟级（`diagnoseSchedule` 拒绝小于 1 分钟的间隔），
   * 30 秒的 tick 保证分钟边界不会被整体错过一格。
   * `unref()` 让它不阻止进程退出——定时任务不该成为「关不掉」的理由。
   */
  const SCHEDULER_TICK_MS = 30_000
  const schedulerTimer = setInterval(() => {
    void tickSchedules()
  }, SCHEDULER_TICK_MS)
  schedulerTimer.unref?.()

  async function tickSchedules(): Promise<void> {
    if (restricted || !workspace) return
    const all = await loadSchedules().catch(() => [] as Schedule[])
    // 只管本工作区的：一台机器上可能同时开着两个工作区的 sidecar，
    // 不加这条过滤会让同一条任务被触发两次。
    const mine = all.filter((s) => s.workspaceRoot === workspaceRoot)
    if (!mine.length) return

    const now = Date.now()
    // 先收集要打的补丁，最后**在一次串行的读-改-写里**落盘。
    // 直接改这份快照再整表回写的话，这段 await 期间用户在设置页新建 / 删除的任务
    // 会被这份过期快照抹掉——两条写入路径各拿各的快照，就是标准的丢更新。
    const patches = new Map<string, Partial<Schedule>>()
    for (const s of mine) {
      if (!isDue(s, now)) continue
      const patch: Partial<Schedule> = { lastRunAt: now }
      patches.set(s.id, patch)
      try {
        const conv = createConversation(opts.store, {
          workspaceId: workspace.id as never,
          provider: opts.config.active.provider,
          model: opts.config.active.model,
          title: s.title,
        })
        patch.lastRunConversationId = conv.id
        await startRun(conv.id, s.prompt, undefined, {
          researchControllerOnly,
          store: opts.store,
          content,
          config: opts.config,
          bus,
          runs,
        })
      } catch (err) {
        // 失败也要把 lastRunAt 留在已更新的状态：否则下一个 tick 会立刻重试，
        // 一个稳定失败的任务会变成每 30 秒刷一个新会话。
        patch.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (patches.size === 0) return

    await updateSchedules((cur) =>
      cur.map((s) => {
        const patch = patches.get(s.id)
        if (!patch) return s
        // 成功那次要把上一轮的错误清掉；`lastError` 在补丁里没有就是「这次没错」。
        const { lastError: _prev, ...rest } = s
        return { ...rest, ...patch }
      }),
    ).catch(() => {})
  }

  /**
   * 局域网监听控制。
   *
   * 默认只绑 127.0.0.1——一启动就把工作区暴露在整个 Wi-Fi 上不是合理默认。
   * 用户点「允许手机接入」时**追加**一个 0.0.0.0 的监听器，而不是重启服务：
   * 重启会断掉桌面端的 WebSocket、丢掉正在跑的 run，代价太大。
   *
   * 两个监听器共用同一个 bus / runs / store，手机连上后看到的是同一份状态。
   * 这里用后赋值的引用是因为它们要复用主 server 的 handler，而 handler 又要
   * 能调到这几个函数——循环引用只能靠延迟解析打破。
   */
  let lanServer: ReturnType<typeof Bun.serve<SocketData>> | null = null
  let boundPort = opts.port

  let lanPort = 0
  const researchControlDeps = (workspaceId: string, workspaceRoot: string) => ({
    store: opts.store,
    config: opts.config,
    bus,
    runs,
    pairing,
    token,
    port: boundPort,
    enableLan,
    disableLan,
    lanEnabled,
    lanPort: () => lanPort,
    startRun: () => {},
    watchGit: () => gitWatch.retarget(),
    workspaceId,
    workspaceRoot,
    ...(researchHumanAuth ? { researchHumanAuth } : {}),
    researchRequireApproval,
    ...(researchLiteratureCollector ? { researchLiteratureCollector } : {}),
    ...(researchDaemonBackend ? { researchDaemonBackend } : {}),
    ...(!restricted && opts.researchReviewCli ? { researchReviewCli: opts.researchReviewCli } : {}),
    ...(researchExecutionDevices ? { researchExecutionDevices } : {}),
    researchControllerOnly,
    ...(researchCliPreparation ? { researchCliPreparation } : {}),
    ...(researchFormalExecution ? { researchFormalExecution } : {}),
    ...(researchNotifications ? { researchNotifications } : {}),
  })

  const boundedScheduler = restricted
    ? undefined
    : createBoundedScheduler({
        store: opts.store,
        isBusy: (id) => runs.isBusy(id),
        changed: () => publishResearchEvents(opts.store, bus, researchNotifications),
        onError: (error) =>
          console.error(
            'Bounded research scheduling failed',
            error instanceof Error ? error.message : 'unknown error',
          ),
        startStudyHandoff: (conversationId, prompt) => {
          void startRun(conversationId, prompt, undefined, {
            store: opts.store,
            content,
            config: opts.config,
            bus,
            runs,
            researchControlPortFactory: ({
              workspaceId,
              workspaceRoot,
              campaignIds,
              conversationId,
            }) =>
              createResearchControlPort(
                researchControlDeps(workspaceId, workspaceRoot),
                campaignIds,
                conversationId,
              ),
            researchControlFactory: ({
              workspaceId,
              workspaceRoot,
              campaignIds,
              conversationId,
              signal,
            }) =>
              createNativeResearchControlBridge(
                researchControlDeps(workspaceId, workspaceRoot),
                campaignIds,
                signal,
                undefined,
                conversationId,
              ),
          })
        },
        startRun: (conversationId, prompt) => {
          void startRun(conversationId, prompt, undefined, {
            store: opts.store,
            content,
            config: opts.config,
            bus,
            runs,
            researchControllerOnly: true,
            researchControlPortFactory: ({
              workspaceId,
              workspaceRoot,
              campaignIds,
              conversationId,
            }) =>
              createResearchControlPort(
                researchControlDeps(workspaceId, workspaceRoot),
                campaignIds,
                conversationId,
              ),
          })
        },
      })

  /**
   * 局域网监听用**另一个端口**，不是主端口。
   *
   * `0.0.0.0:P` 与已绑的 `127.0.0.1:P` 在同一端口上冲突，直接报
   * 「Failed to start server. Is port P in use?」。
   * 所以传 port 0 让内核挑一个空闲的，二维码指向这个新端口。
   */
  const enableLan = (): { port: number } => {
    if (researchDeployment)
      throw new Error('Deployment contract forbids widening the loopback listener')
    if (!lanServer) {
      // 复用同一份 handler：两个监听器共用 bus / runs / store，
      // 手机连上后看到的是同一份状态，不是另一个副本。
      lanServer = Bun.serve<SocketData>({ ...handlers, port: 0, hostname: '0.0.0.0' })
      lanPort = lanServer.port ?? 0
    }
    return { port: lanPort }
  }
  const disableLan = (): void => {
    lanServer?.stop(true)
    lanServer = null
    lanPort = 0
  }
  const lanEnabled = (): boolean => lanServer !== null

  // handler 抽出来给两个监听器共用。
  // 只写第一个类型参数：Bun 的签名是 serve<WebSocketData, R extends string>，
  // 第二个是路由表的路径键，这里走 fetch 手动分派，没有路由表。
  const handlers = {
    // agent 的一轮可能跑很久，默认超时会把 WebSocket 掐掉。
    idleTimeout: 255,

    async fetch(req: Request, srv: Bun.Server<SocketData>) {
      const url = new URL(req.url)

      // ── WebSocket 升级 ──
      if (url.pathname === '/stream') {
        // 握手期就验令牌：不让未授权连接进入 ws 生命周期。
        if (!pairing.verify(extractToken(req))) {
          return new Response('unauthorized', { status: 401 })
        }
        if (restricted) return withCors(json({ error: RESTRICTED_RESEARCH_CAPABILITY_DENIED }, 403))
        const ok = srv.upgrade(req, {
          data: {
            id: crypto.randomUUID(),
            authed: true,
            origin: (url.searchParams.get('origin') as SocketData['origin']) ?? 'external',
          },
        })
        return ok ? undefined : new Response('upgrade failed', { status: 400 })
      }

      // ── 跨源预检：必须答在验令牌之前 ──
      // 预检按规范不带 Authorization，用同一把尺子量它只会得到 401，
      // 而 401 的预检意味着**真正那条请求不会发出**。详见 CORS_HEADERS。
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      // ── 健康检查：唯一免鉴权的端点，只回协议版本 ──
      if (url.pathname === '/api/health') {
        return withCors(json({ ok: true }))
      }

      if (url.pathname.startsWith('/api/')) {
        if (!pairing.verify(extractToken(req))) {
          return withCors(json({ error: 'unauthorized' }, 401))
        }
        if (req.method === 'GET' && url.pathname === '/api/research/security') {
          return withCors(
            json({ researchBoundary, clinicalBackend: 'unavailable', mutableViaApi: false }),
          )
        }
        if (req.method === 'GET' && url.pathname === '/api/research/deployment') {
          return withCors(
            json({ deployment: researchDeployment ?? null, clinicalAcceptance: false }),
          )
        }
        if (req.method === 'GET' && url.pathname === '/api/research/execution-backend') {
          return withCors(
            json({
              backend:
                researchDaemonBackend && 'kind' in researchDaemonBackend
                  ? researchDaemonBackend.kind
                  : researchDaemonBackend
                    ? 'localhost-daemon'
                    : 'builtin-local',
              backendPolicyHash:
                researchDaemonBackend && 'backendPolicyHash' in researchDaemonBackend.daemon
                  ? researchDaemonBackend.daemon.backendPolicyHash
                  : null,
              trackingPolicyHash: researchDaemonBackend?.daemon.trackingPolicyHash ?? null,
              clinicalAcceptance: false,
            }),
          )
        }
        if (req.method === 'GET' && url.pathname === '/api/research/execution-devices') {
          return withCors(
            json(
              await quoteResearchDevice(
                researchExecutionDevices ??
                  (researchDaemonBackend && 'availability' in researchDaemonBackend.daemon
                    ? [{ id: 'configured', authority: researchDaemonBackend.daemon }]
                    : []),
              ),
            ),
          )
        }
        if (restricted) return withCors(json({ error: RESTRICTED_RESEARCH_CAPABILITY_DENIED }, 403))
        try {
          if (req.method === 'POST' && url.pathname === '/api/commands') {
            const command = (await req.json()) as ClientCommand
            if (command?.type !== 'workflow.review')
              return withCors(json({ error: '仅支持检查点决策' }, 400))
            const result = await handleCommand(command, {
              store: opts.store,
              content,
              config: opts.config,
              bus,
              runs,
            })
            return withCors(json(result, result?.ok ? 202 : 409))
          }
          const res = await handleApi(url, req, {
            store: opts.store,
            config: opts.config,
            bus,
            runs,
            pairing,
            token,
            port: srv.port ?? opts.port,
            enableLan,
            disableLan,
            lanEnabled,
            lanPort: () => lanPort,
            // 定时任务的「立刻跑一次」走这条，与正常对话完全同一条路径。
            // 注入而不是让 api 模块 import：那会成环（server → api → server）。
            startRun: (conversationId, prompt) => {
              void startRun(conversationId, prompt, undefined, {
                store: opts.store,
                content,
                config: opts.config,
                bus,
                runs,
                researchControllerOnly,
                researchControlFactory: ({
                  workspaceId,
                  workspaceRoot,
                  campaignIds,
                  signal,
                  conversationId,
                }) =>
                  createNativeResearchControlBridge(
                    researchControlDeps(workspaceId, workspaceRoot),
                    campaignIds,
                    signal,
                    undefined,
                    conversationId,
                  ),
                researchControlPortFactory: ({
                  workspaceId,
                  workspaceRoot,
                  campaignIds,
                  conversationId,
                }) =>
                  createResearchControlPort(
                    researchControlDeps(workspaceId, workspaceRoot),
                    campaignIds,
                    conversationId,
                  ),
              })
            },
            watchGit: () => gitWatch.retarget(),
            ...(researchHumanAuth ? { researchHumanAuth } : {}),
            ...(researchFormalCodeReviewer ? { researchFormalCodeReviewer } : {}),
            ...(!restricted && opts.researchFormalCatalog
              ? { researchFormalCatalog: structuredClone(opts.researchFormalCatalog) }
              : {}),
            ...(opts.researchFormalEvaluators
              ? { researchFormalEvaluators: opts.researchFormalEvaluators }
              : {}),
            ...(opts.researchHumanAuth?.approvalUrl
              ? { researchApprovalUrl: opts.researchHumanAuth.approvalUrl }
              : {}),
            researchRequireApproval,
            ...(researchLiteratureCollector ? { researchLiteratureCollector } : {}),
            ...(researchDaemonBackend ? { researchDaemonBackend } : {}),
            ...(!restricted && opts.researchReviewCli
              ? { researchReviewCli: opts.researchReviewCli }
              : {}),
            ...(researchExecutionDevices ? { researchExecutionDevices } : {}),
            researchControllerOnly,
            ...(researchCliPreparation ? { researchCliPreparation } : {}),
            ...(researchFormalExecution ? { researchFormalExecution } : {}),
            ...(researchNotifications ? { researchNotifications } : {}),
          })
          if (res) return withCors(res)
        } catch (err) {
          return withCors(json({ error: err instanceof Error ? err.message : String(err) }, 500))
        }
        return withCors(json({ error: 'not found' }, 404))
      }

      // ── 静态资源 ──
      if (restricted) return withCors(json({ error: RESTRICTED_RESEARCH_CAPABILITY_DENIED }, 403))
      if (opts.staticDir) {
        const served = await serveStatic(opts.staticDir, url.pathname)
        if (served) return served
      }
      return new Response('oph-autoresearch server', { status: 200 })
    },

    websocket: {
      async message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
        if (restricted) {
          ws.close(1008, RESTRICTED_RESEARCH_CAPABILITY_DENIED)
          return
        }
        let frame: HelloFrame | ClientCommand
        try {
          frame = JSON.parse(String(raw))
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'bad json' }))
          return
        }

        if (frame.type === 'hello') {
          handleHello(ws, frame, {
            bus,
            token,
            unsubscribers,
            config: opts.config,
            runs,
            announceGit: () => gitWatch.announce(),
          })
          return
        }

        await handleCommand(frame as ClientCommand, {
          ws,
          store: opts.store,
          content,
          config: opts.config,
          bus,
          runs,
          researchControllerOnly,
          researchControlFactory: ({
            workspaceId,
            workspaceRoot,
            campaignIds,
            signal,
            conversationId,
          }) =>
            createNativeResearchControlBridge(
              researchControlDeps(workspaceId, workspaceRoot),
              campaignIds,
              signal,
              undefined,
              conversationId,
            ),
          researchControlPortFactory: ({
            workspaceId,
            workspaceRoot,
            campaignIds,
            conversationId,
          }) =>
            createResearchControlPort(
              researchControlDeps(workspaceId, workspaceRoot),
              campaignIds,
              conversationId,
            ),
        })
      },
      close(ws: ServerWebSocket<SocketData>) {
        unsubscribers.get(ws.data.id)?.()
        unsubscribers.delete(ws.data.id)
      },
    },
  }

  const server = Bun.serve<SocketData>({
    ...handlers,
    port: opts.port,
    hostname: opts.host,
  })
  boundPort = server.port ?? opts.port
  feishu?.start(researchNotifications)
  if (!restricted && !process.env.OPH_AUTORESEARCH_TEST_TEMP)
    void refreshCliCatalog().catch(() => undefined)

  // 分支名跟着 `.git/HEAD` 走，理由与边界都在 `git-watch.ts`。
  if (!restricted) gitWatch.retarget()

  return {
    server,
    bus,
    runs,
    content,
    token,
    port: boundPort,
    // 启动横幅要显示的是**真正生效的**工作区。调用方传进来的可能是 null
    // （没给 --cwd），那时由 bootstrapWorkspace 决定用哪个，只有这里知道结果。
    workspaceRoot,
    enableLan,
    disableLan,
    lanEnabled: () => lanServer !== null,
    pairingUrl: () => pairing.qrUrl(boundPort),
    lanUrl: () => `http://${preferredLanAddress()}:${boundPort}`,
    stop() {
      for (const device of researchExecutionDevices ?? []) device.authority.close()
      researchDaemonBackend?.daemon.close()
      researchCliPreparation?.close()
      formalController?.close()
      for (const client of formalSshClients) client.close()
      for (const route of cliPreparationRoutes) {
        if ('close' in route.authority && typeof route.authority.close === 'function')
          route.authority.close()
      }
      feishu?.close()
      researchNotifications?.close()
      boundedScheduler?.close()
      clearInterval(schedulerTimer)
      gitWatch.stop()
      runs.interruptAll()
      disableLan()
      server.stop(true)
      // 插件是子进程，不显式关会留下孤儿——sidecar 与截图脚本上是同一条约束。
      pluginTeardown?.()
      // 只关自己开的：外部传进来的正文库归调用方管，替它关掉会让它下一次读抛错。
      if (ownsContent) content.close()
    },
  }
}

// ───────────────────────── WebSocket ─────────────────────────

export type AgentEventFrame = EventEnvelope<AgentEvent>
