# 科研账本第一批实施回执

## 执行进度看板

- 最后更新：2026-09-05。
- 实施目录：`D:/PROJECT/Autosearch/oph-autoresearch-repo`，直接增量整合，无另建 worktree。
- 分支基线：`feat/mvp-research-workbench`，`e4d3322f19b33c545819b4b5e15a50eaee4c5d33`。
- 当前批次：基础账本与提案 API/UI；自测通过，未由用户亲测验收。
- 下一步：完成本批检查，再推进 TaskRevision/Attempt 本地合成数据闭环。

## 本批交付

由 GPT-6 Astra 主控串行整合，两个明确指定的 GPT-5.6 Terra 分别实现科研领域/存储和取消/父归属。软件研究角色没有硬编码这两个模型。

1. `TeamOrchestrator` 收到取消后停止新派发，等待已经启动的节点收尾，以 failed 返回兼容结果。新增并发取消回归。
2. 子会话创建持久化 parentConversationId，续接检查父会话归属。迁移 36 为普通会话加父引用；普通父会话删除级联子会话。科研账本不随聊天或工作区删除。
3. 新增 ResearchCampaign、ArtifactVersion、HumanApproval、ResearchEvent。迁移 35 建事件、投影、outbox 和幂等表。历史迁移保持原样。科研事件包含版本快照，投影可重建，包括缺行、损坏的归属索引字段和重启读取。
4. 创建及变更的幂等键绑定规范请求；同键异负载返回冲突，expectedVersion 实现 CAS。产物版本不可覆盖；产物/策略/输入/预算变化使已绑定审批失效，撤销保留历史。
5. HTTP 接入现有应用鉴权与 workspace 派发器。API 只允许提案和读取，批准/撤销始终返回 403 `human_identity_unavailable`。请求 actor、reviewer 或应用 token 均不能将提案升级成人类批准。
6. 中央阶段详情可真实创建、刷新和读取当前会话科研提案，显示版本、登记产物与审批事实。旧六阶段聊天视图继续保留并标记 `legacy_unverified`；“等待人工审核”改为“等待主会话模型审查”。

## 可用 HTTP 契约

所有路径支持现有 `?ws=<workspaceId>` 作用域；复用应用访问令牌，不具有人类审批权限。

| 方法与路径 | 行为 |
|---|---|
| GET `/api/research/campaigns?conversationId=...` | 列出当前工作区研究提案，可按父会话筛选 |
| POST `/api/research/campaigns` | `{parentConversationId, goal, idempotencyKey}` 创建未批准提案，初始预算为 0 |
| GET `/api/research/campaigns/:id` | 读取持久化版本快照，`campaign.version` 等于该 Campaign 最后事件序号 |
| GET `/api/research/campaigns/:id/events` | 顺序读取全部科研事件 |
| POST `/api/research/campaigns/:id/proposals` | `{idempotencyKey, expectedVersion, command}`，仅接受下面四种提案 |
| `/api/research/campaigns/:id/approve`、`/revoke` | 封闭，403；没有可用网络人类审批流程 |

公开命令：`setPolicy {policy}`、`setInputs {inputs}`、`setBudget {budget:{currency,limit}}`、`recordArtifact {artifactId,uri,artifactKind,contentHash}`。contentHash 格式为 `sha256:` 加 64 位小写十六进制。URI 只是引用，不触发读取或远程操作。

版本过期、幂等键负载冲突返回 409。非法字段/命令返回 400，跨工作区读取返回 404。同键重试返回原始成功版本快照，即使其后已有新版本；调用方需要最新状态时再 GET。

## 真实限制

本节已按第二批整合更新；第一批的验收数字和文件哈希对照仍作为当时快照保留。当前最终结果见 [第二批回执](2026-09-05-local-synthetic.md)。

- 手动登记的 SHA256 仍是声明值；第二批内置合成 Runner 会读取产物字节并核验固定输出合同。这不代表真实科研证据或临床结论已经核验。
- outbox 已在第二批接入 EventBus，通知按 campaignSeq 去重，界面读取 REST 快照补齐。跨服务持久消息投递和大规模分页尚未实现。
- ResearchEvent 内已包含固定合成 TaskRevision/Attempt 状态快照；没有通用科研 DAG、分布式 lease/fencing、SSH JobSpec、费用路由或远端核对。
- 内部存储批准语义有测试，网络人类审批入口封闭。没有将客户端可获取的 nonce/token 宣称为人类身份。
- 未连接患者服务器或专用合成 SSH 环境，未运行远端实验。构建验证不等于真实 SSH 纵切片验收。
- UI 通过 Solid DOM 行为测试和生产构建；未声称实际桌面人工视觉验收通过。

## 文件保全

基线已修改的 42 个文件中，37 个 SHA256 字节不变；5 个共享文件有本批必要增量：ResearchWorkspace.tsx、panel.css、core/index.ts、store/index.ts、store/repos.ts。没有覆盖既有修改、提交或推送。原先两个未跟踪入口保留。精确哈希对照保存在本地 `.tmp/pro-review-2026-09-05/research-batch-preservation.json`。

额外修正一个验证夹具竞态：`followup.test.ts` 原 gate 在 provider 请求到达前调用 release 会丢失放行，导致全量测试偶发超时。提前创建 Promise 保存放行状态，原产品断言和产品实现不变。

## 对照整体任务包

完整输入见 [Pro 任务包](../pro-task-package-2026-09-05.md)，本回执只覆盖下表的第一批基础部分。

| 项目 | 本批结论 |
|---|---|
| A00/A01 基线、文件归属、共享整合 | 本批完成；整体合同仍需随 TaskRevision/Attempt 扩展 |
| T01/T02 领域与持久层 | 两批已完成基础账本与固定合成 TaskRevision/Attempt；通用任务图合同待做 |
| T03 数据出口策略 | 待做；可在本地合成 canary 上实施，不依赖真实 SSH |
| T04 人类批准/精确返工 | 部分完成版本绑定/撤销/失效；可信身份和依赖闭包待做 |
| T05/T07 Runner 与科研调度 | 本地固定合成 Runner、取消/恢复已实现；远端执行和通用调度待做 |
| T06/T09 API/界面 | REST 提案/读取、合成执行、outbox 通知与状态显示已实现；完整六阶段和人类审批交互待做 |
| T08 Skills/SourceSnapshot | 待做，来源锁定、hash/许可证/权限与评测可本地推进 |
| T10/T12 合成评价及故障注入 | 确定性合成统计和本地真实 HTTP 闭环已验证；ML/临床评价与真实 SSH 验收待做 |
| T11 上游移植 | 已有两个经本地取证的修复，完整固定 SHA 差异审计待做 |
| A02 完整 P0 验收 | 未完成；本批不可标记为整体优化或完整 P0 完成 |

原建议的本地合成纵切片已在第二批实现；下一步可本地继续数据出口 canary、任务依赖闭包、模板输出合同扩展和 Skills 来源锁定。独立可信身份只阻塞真实人工批准；专用 SSH 目标只阻塞真实远端验收，不阻塞这些本地工作。

## 验证结果

最终 `.tmp/bun-shim/bun.exe run gate` 返回 0：TypeScript、全仓 Biome、完整测试、Rust cargo check 全部通过。测试为 2213 通过、1 跳过、0 失败，11056 断言，141 个文件；跳过项为当前平台的写路径软链测试。

新增科研领域/存储定向测试为 10 通过、39 断言；API/UI/SidePanel 集成测试为 8 通过。取消、父归属的定向结果见 [单独回执](2026-09-05-cancel-ownership.md)。全量测试同时覆盖这些文件。

生产构建 `.tmp/bun-shim/bun.exe run build` 返回 0，Vite web、99.3 MB Windows sidecar 与 `oph 0.1.8` 版本自检均通过。构建保留既有 FileView 静态/动态混合导入提示，不影响成功产物。

验证过程曾发现新增 UI 测试的多 document 事件派发问题，以及旧 followup 测试的提前放行丢失竞态，两者修复后完整 gate 已成功。没有以删断言或跳过失败测试通过门禁。本地日志：`.tmp/pro-review-2026-09-05/research-batch-gate.log`、`research-batch-build.log`。
