import { getWorkspace } from '@oph-autoresearch/store'
import type { ApiRequestDeps } from '../api/types.ts'
import { cliCatalogSnapshot } from '../cli-catalog.ts'
import { matchingFormalRoutes, resolveFormalScope } from './formal-runtime.ts'

/** Configuration facts only: never launches SSH, installs a runtime, or grants approval. */
export async function researchReadiness(deps: ApiRequestDeps) {
  const checkedAt = Date.now()
  const workspace = getWorkspace(deps.store, deps.workspaceId as never)
  const binding = await resolveFormalScope(
    deps.store,
    { workspaceId: deps.workspaceId, workspaceRoot: deps.workspaceRoot, campaignId: '' },
    deps.resolveFormalWorkspaceBinding,
  ).catch(() => null)
  const routes =
    binding && deps.researchFormalExecution
      ? matchingFormalRoutes(deps.researchFormalExecution.routes, binding)
      : []
  const catalog = deps.researchFormalCatalog
  const checks: {
    key: string
    label: string
    status: 'ready' | 'blocked' | 'unknown'
    detail: string
  }[] = []
  const configured = (key: string, label: string, ready: boolean, detail: string) =>
    checks.push({ key, label, status: ready ? 'ready' : 'blocked', detail })
  configured(
    'binding',
    '项目目录绑定',
    Boolean(binding),
    binding
      ? `本机 ${workspace!.rootPath}；服务器 ${binding.remoteRoot}。已核对保存的连接配置，未实时连接服务器。`
      : '目录尚未绑定，或保存的服务器配置已删除、变更。请在项目侧栏核对绑定。',
  )
  configured(
    'approval',
    '独立审批渠道',
    Boolean(deps.researchHumanAuth && deps.researchApprovalUrl),
    deps.researchHumanAuth && deps.researchApprovalUrl
      ? '已装配独立身份验证与审批入口；每次执行仍需匹配当前任务的有效批准。'
      : '尚未装配独立身份验证与审批入口；应用访问令牌不能代替人类批准。',
  )
  const cliRoutes = deps.researchCliPreparation?.catalog() ?? []
  configured(
    'cli_route',
    '远端 CLI 执行配置',
    cliRoutes.length > 0,
    cliRoutes.length
      ? '服务已登记 CLI 准备路线；具体任务仍需核对路线、批准和远端状态。'
      : '尚未配置可执行的远端 CLI 路线。CLI 登录探针不授予执行权限。',
  )
  configured(
    'formal_backend',
    '项目隔离执行后端',
    routes.length === 1,
    routes.length === 1
      ? '当前绑定唯一匹配已登记隔离验收依据的 Linux OCI 后端；提交时仍会重新核验。'
      : '未配置唯一匹配当前项目目录且通过验证的 Linux OCI 执行后端。',
  )
  configured(
    'images',
    '正式镜像目录',
    Boolean(catalog?.images.length),
    catalog?.images.length ? '已登记固定摘要的镜像。' : '管理员尚未登记正式镜像。',
  )
  configured(
    'datasets',
    '正式数据目录',
    Boolean(catalog?.datasets.length),
    catalog?.datasets.length
      ? '已登记数据清单与标签摘要。'
      : '管理员尚未登记正式数据清单与标签摘要。',
  )
  configured(
    'evaluator',
    '受信评估器',
    Boolean(catalog?.evaluators.length),
    catalog?.evaluators.length ? '已登记固定实现摘要的评估器。' : '管理员尚未登记受信评估器。',
  )
  checks.push({
    key: 'ssh_live',
    label: '当前 SSH 与运行时实测',
    status: 'unknown',
    detail:
      '本次配置预检未执行 SSH 命令，连通性、目录可写和当前容器运行状态均未实测；未检查项不能判定通过。',
  })
  const snapshot = cliCatalogSnapshot()
  const probes = binding
    ? snapshot.agents
        .filter((a) => a.profileId === binding.profileId)
        .map((a) => ({
          cli: a.id,
          status: a.probe?.status ?? 'unknown',
          checkedAt: a.probe?.checkedAt ?? null,
          fresh: Boolean(
            a.probe &&
              checkedAt - a.probe.checkedAt >= 0 &&
              checkedAt - a.probe.checkedAt < 5 * 60_000,
          ),
        }))
    : []
  return {
    checkedAt,
    formalConfigurationReady: checks.every((check) => check.status !== 'blocked'),
    checks,
    cliProbes: { source: 'cached-login-probe', probes, provesExecution: false },
    note: '这是当前服务配置快照，不是实验授权或实时执行验收。普通 SSH 文件操作、CLI 登录和正式科研执行是不同能力。正式运行还需当前方案、候选代码、独立审查和任务绑定的有效批准。',
  }
}
